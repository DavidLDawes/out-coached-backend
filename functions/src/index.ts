import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { advanceAfterVoidHandler, settlePlayHandler, undoLastSettlementHandler } from "./handlers";
import {
  cancelHoldHandler,
  handleMomentSignal,
  handleReport,
  monitorVoidPlayHandler,
  scheduleGameHandler,
  sweepCrowdGames,
  type ScheduleGameArgs,
} from "./crowdHandlers";
import { isFirstGoingLive, sendGameLiveNotification } from "./notifications";
import type { Game, MomentSignal, Play } from "./types";

initializeApp();

// Deploy/emulator smoke test only.
export const ping = onRequest((_req, res) => {
  res.status(200).send("ok");
});

/**
 * DESIGN.md §6 settlement sequencing. Fires the moment a play's result is
 * newly recorded (operator's enterResult write — state stays "locked",
 * `result` appears for the first time). Guards on "result just appeared"
 * rather than "state == locked" alone, so this function's own writes
 * (settling -> settled) and undo's writes (clearing result) don't cause it
 * to recurse into itself. See handlers.ts for the actual settlement logic.
 */
export const settlePlay = onDocumentUpdated("games/{gameId}/plays/{playId}", async (event) => {
  const before = event.data?.before.data() as Play | undefined;
  const after = event.data?.after.data() as Play | undefined;
  const { gameId, playId } = event.params as { gameId: string; playId: string };

  if (!after || after.state !== "locked" || !after.result) return;
  if (before?.result) return;

  logger.info("settlePlay triggered", { gameId, playId });
  try {
    await settlePlayHandler(getFirestore(), gameId, playId);
  } catch (error) {
    logger.error("settlePlay failed", { gameId, playId, error: String(error) });
    throw error;
  }
});

/**
 * Opens the next play after VOID (no money moves — see handlers.ts).
 */
export const advanceAfterVoid = onDocumentUpdated("games/{gameId}/plays/{playId}", async (event) => {
  const before = event.data?.before.data() as Play | undefined;
  const after = event.data?.after.data() as Play | undefined;
  const { gameId, playId } = event.params as { gameId: string; playId: string };

  if (!after || after.state !== "voided" || before?.state === "voided") return;

  logger.info("advanceAfterVoid triggered", { gameId, playId });
  try {
    await advanceAfterVoidHandler(getFirestore(), gameId, playId);
  } catch (error) {
    logger.error("advanceAfterVoid failed", { gameId, playId, error: String(error) });
    throw error;
  }
});

/**
 * DESIGN.md §5.1/§9 step 3: pings the game's FCM topic the moment the game
 * *first* goes live — the Android app subscribes to `game_{gameId}` on join.
 * Only the initial scheduled/undefined -> live transition qualifies; a crowd
 * game also goes halftime -> live at the second-half snap
 * (crowdHandlers.ts), which is not a "come watch, it's starting" moment and
 * would otherwise double-notify players already in the game.
 */
export const notifyGameLive = onDocumentUpdated("games/{gameId}", async (event) => {
  const before = event.data?.before.data() as Game | undefined;
  const after = event.data?.after.data() as Game | undefined;
  const { gameId } = event.params as { gameId: string };

  if (!isFirstGoingLive(before?.status, after?.status)) {
    if (before?.status === "halftime" && after?.status === "live") {
      logger.debug("notifyGameLive: suppressed duplicate push at second-half snap", { gameId });
    }
    return;
  }

  logger.info("notifyGameLive triggered", { gameId });
  try {
    await sendGameLiveNotification(gameId);
  } catch (error) {
    logger.error("notifyGameLive failed", { gameId, error: String(error) });
    throw error;
  }
});

/**
 * DESIGN.md §3/§7.2 (+§12.9): reverses the most recent settled play.
 * Operators for operator-driven games; the `monitor` custom claim for
 * crowd-run games. See handlers.ts for the actual reversal logic.
 */
export const undoLastSettlement = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");

  const { gameId, playId } = (request.data ?? {}) as { gameId?: string; playId?: string };
  if (!gameId || !playId) throw new HttpsError("invalid-argument", "gameId and playId are required.");

  const isMonitor = request.auth?.token?.monitor === true;
  logger.info("undoLastSettlement called", { gameId, playId, uid, isMonitor });
  try {
    return await undoLastSettlementHandler(getFirestore(), gameId, playId, uid, isMonitor);
  } catch (error) {
    if (!(error instanceof HttpsError)) {
      logger.error("undoLastSettlement failed", { gameId, playId, uid, error: String(error) });
    }
    throw error;
  }
});

// ---------------------------------------------------------------------------
// Crowd-run games — DESIGN.md §12 / PLAN.md CR-2
// ---------------------------------------------------------------------------

/**
 * §12.2 — game-level moment signals (kickoff, period markers, commercial
 * mode). Burst detection and state transitions live in crowdHandlers.ts.
 */
export const onMomentSignalCreated = onDocumentCreated(
  "games/{gameId}/momentSignals/{signalId}",
  async (event) => {
    const { gameId } = event.params as { gameId: string };
    const signal = event.data?.data() as MomentSignal | undefined;
    if (!signal) return;
    try {
      await handleMomentSignal(getFirestore(), gameId, signal.momentType);
    } catch (error) {
      logger.error("onMomentSignalCreated failed", { gameId, momentType: signal.momentType, error: String(error) });
      throw error;
    }
  },
);

/**
 * §12.2/§12.3 — per-play crowd reports (snap bursts, type/result votes).
 */
export const onReportCreated = onDocumentCreated(
  "games/{gameId}/plays/{playId}/reports/{reportId}",
  async (event) => {
    const { gameId, playId } = event.params as { gameId: string; playId: string };
    try {
      await handleReport(getFirestore(), gameId, playId);
    } catch (error) {
      logger.error("onReportCreated failed", { gameId, playId, error: String(error) });
      throw error;
    }
  },
);

/**
 * §12.3 timeout sweep + §12.9 hold expiry. Cloud Scheduler's floor is one
 * minute (PLAN.md said ~10s; that isn't available) — in practice the
 * per-write trigger finalizes active votes, and this catches stalls.
 */
export const crowdSweep = onSchedule("every 1 minutes", async () => {
  try {
    await sweepCrowdGames(getFirestore());
  } catch (error) {
    logger.error("crowdSweep failed", { error: String(error) });
    throw error;
  }
});

/** §12.9 — monitor-only: cancel a pending end_game/start_ot hold. */
export const cancelHold = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
  const { gameId } = (request.data ?? {}) as { gameId?: string };
  if (!gameId) throw new HttpsError("invalid-argument", "gameId is required.");

  logger.info("cancelHold called", { gameId, uid });
  await cancelHoldHandler(getFirestore(), gameId, request.auth?.token?.monitor === true);
});

/** §12.9 — monitor-only: void the current play from the monitor console. */
export const monitorVoidPlay = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");
  const { gameId, playId } = (request.data ?? {}) as { gameId?: string; playId?: string };
  if (!gameId || !playId) throw new HttpsError("invalid-argument", "gameId and playId are required.");

  logger.info("monitorVoidPlay called", { gameId, playId, uid });
  await monitorVoidPlayHandler(getFirestore(), gameId, playId, request.auth?.token?.monitor === true);
});

/**
 * §12.10 / §11.7 — scheduling-admin callable: create a game ahead of time.
 * Gated on the operator custom claim.
 */
export const scheduleGame = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");

  const args = (request.data ?? {}) as ScheduleGameArgs;
  logger.info("scheduleGame called", { gameId: args.gameId, uid });
  return await scheduleGameHandler(getFirestore(), args, uid, request.auth?.token?.operator === true);
});
