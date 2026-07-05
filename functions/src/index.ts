import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { advanceAfterVoidHandler, settlePlayHandler, undoLastSettlementHandler } from "./handlers";
import { sendGameLiveNotification } from "./notifications";
import type { Game, Play } from "./types";

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
 * DESIGN.md §5.1/§9 step 3: pings the game's FCM topic the moment status
 * flips to "live" — the Android app subscribes to `game_{gameId}` on join.
 */
export const notifyGameLive = onDocumentUpdated("games/{gameId}", async (event) => {
  const before = event.data?.before.data() as Game | undefined;
  const after = event.data?.after.data() as Game | undefined;
  const { gameId } = event.params as { gameId: string };

  if (before?.status === "live" || after?.status !== "live") return;

  logger.info("notifyGameLive triggered", { gameId });
  try {
    await sendGameLiveNotification(gameId);
  } catch (error) {
    logger.error("notifyGameLive failed", { gameId, error: String(error) });
    throw error;
  }
});

/**
 * DESIGN.md §3/§7.2: operator-only, reverses the most recent settled play.
 * See handlers.ts for the actual reversal logic.
 */
export const undoLastSettlement = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");

  const { gameId, playId } = (request.data ?? {}) as { gameId?: string; playId?: string };
  if (!gameId || !playId) throw new HttpsError("invalid-argument", "gameId and playId are required.");

  logger.info("undoLastSettlement called", { gameId, playId, uid });
  try {
    return await undoLastSettlementHandler(getFirestore(), gameId, playId, uid);
  } catch (error) {
    if (!(error instanceof HttpsError)) {
      logger.error("undoLastSettlement failed", { gameId, playId, uid, error: String(error) });
    }
    throw error;
  }
});
