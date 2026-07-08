// The actual business logic behind each Cloud Function, separated from the
// trigger/event glue in index.ts so it can be exercised directly against
// the Firestore emulator in tests — no need to simulate CloudEvents or run
// the Functions emulator to test what these do to Firestore state.

import { FieldValue, Firestore, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { adjacentPlayId, clampStakeToBalance, computeSettlement, selectCountedWagers, type CountedWager } from "./settlement";
import { computeAccuracy, computeTopBalance, type PlayerSummary } from "./leaderboard";
import { latestPerUid } from "./crowd/consensus";
import { resolveCrowdConfig } from "./crowd/config";
import {
  evaluateResultReport,
  evaluateTypeReport,
  passLadderOf,
  type ReportingOutcome,
  type ResultDistanceContext,
} from "./crowd/reportingLedger";
import type { CrowdReport, Game, LedgerEntry, Play, Player, WagerRevision } from "./types";

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * DESIGN.md §8 — recomputed after every settlement and every undo (stats
 * change either way). A full players-collection scan; fine at the ~500
 * players/game scale DESIGN.md §5.3 sizes this for.
 */
async function recomputeLeaderboard(firestore: Firestore, gameId: string): Promise<void> {
  const gameRef = firestore.doc(`games/${gameId}`);
  const playersSnap = await gameRef.collection("players").get();
  const summaries: PlayerSummary[] = playersSnap.docs.map((doc) => {
    const data = doc.data() as Player;
    return { uid: doc.id, name: data.displayName, balance: data.balance, typeWrong: data.stats.typeWrong };
  });

  await gameRef.collection("public").doc("leaderboard").set({
    topBalance: computeTopBalance(summaries),
    accuracy: computeAccuracy(summaries),
    updatedAt: FieldValue.serverTimestamp(),
  });

  logger.info("Leaderboard recomputed", { gameId, playerCount: summaries.length });
}

/**
 * DESIGN.md §12.4 — the reporting-accuracy ledger step, run inside
 * settlement once the official result is known. Rewards reporters who
 * agreed with the crowd's official outcome; penalizes self-serving
 * disagreement (far miss matching the reporter's own wager). Idempotent via
 * an existing-entries check keyed on the reporting ledger doc IDs, since
 * these writes use balance increments rather than absolute values.
 */
async function applyReportingLedger(
  firestore: Firestore,
  gameId: string,
  playId: string,
  game: Game,
  result: { type: "run" | "pass"; bucket: string },
  counted: Map<string, CountedWager>,
  settledBalances: Map<string, number>,
): Promise<void> {
  const gameRef = firestore.doc(`games/${gameId}`);
  const playRef = gameRef.collection("plays").doc(playId);
  const reportsSnap = await playRef.collection("reports").get();
  if (reportsSnap.empty) return;

  const crowd = resolveCrowdConfig(game.config);
  if (crowd.crowdMode !== "live") return;

  const reports = reportsSnap.docs.map((d) => d.data() as CrowdReport);
  const ctx: ResultDistanceContext = {
    runLadder: game.config.buckets.run,
    passLadder: passLadderOf(game.config.buckets.pass, crowd.passCategoricalBuckets),
    passCategorical: crowd.passCategoricalBuckets,
    adjacency: crowd.passBucketAdjacency,
  };

  const outcomes: { outcome: ReportingOutcome; pool: "type" | "result" }[] = [];
  for (const pool of ["type", "result"] as const) {
    const latest = latestPerUid(
      reports
        .filter((r) => r.phase === pool)
        .map((r) => ({ uid: r.playerUid, value: r.value, atMillis: r.reportedAt.toMillis() })),
    );
    for (const report of latest.values()) {
      const wager = counted.get(report.uid);
      // §12.6 eligibility: only reporters with an active stake on this pool.
      if (!wager || (pool === "type" ? wager.typeStake : wager.resultStake) <= 0) continue;
      const outcome =
        pool === "type"
          ? evaluateTypeReport(
              { uid: report.uid, reportedValue: report.value, wagerPick: wager.typePick },
              result.type,
              crowd.reportingBonusCredits,
            )
          : evaluateResultReport(
              { uid: report.uid, reportedValue: report.value, wagerPick: wager.bucketPick },
              result.bucket,
              result.type,
              ctx,
              crowd.reportingBonusCredits,
            );
      if (outcome) outcomes.push({ outcome, pool });
    }
  }
  if (outcomes.length === 0) return;

  // Idempotency: skip anything already written (increments would otherwise
  // double-apply on a retried settlement).
  const existingSnap = await gameRef
    .collection("ledger")
    .where("playId", "==", playId)
    .where("reason", "in", ["reporting_bonus", "reporting_penalty"])
    .get();
  const existingIds = new Set(existingSnap.docs.map((d) => d.id));

  for (const batchOutcomes of chunk(outcomes, 200)) {
    const batch = firestore.batch();
    for (const { outcome, pool } of batchOutcomes) {
      const docId = `${playId}_${outcome.uid}_reporting_${pool}`;
      if (existingIds.has(docId)) continue;
      const balanceAfter = (settledBalances.get(outcome.uid) ?? 0) + outcome.delta;
      settledBalances.set(outcome.uid, balanceAfter);
      batch.update(gameRef.collection("players").doc(outcome.uid), {
        balance: FieldValue.increment(outcome.delta),
      });
      const entry: LedgerEntry = {
        delta: outcome.delta,
        balanceAfter,
        reason: outcome.reason,
        playerUid: outcome.uid,
        playId,
        createdAt: FieldValue.serverTimestamp() as unknown as Timestamp,
      };
      batch.set(gameRef.collection("ledger").doc(docId), entry);
    }
    await batch.commit();
  }
  logger.info("applyReportingLedger: done", { gameId, playId, outcomeCount: outcomes.length });
}

/**
 * DESIGN.md §6 settlement sequencing. Caller (index.ts) is responsible for
 * only invoking this once per "result newly recorded" transition.
 */
export async function settlePlayHandler(firestore: Firestore, gameId: string, playId: string): Promise<void> {
  const gameRef = firestore.doc(`games/${gameId}`);
  const playRef = gameRef.collection("plays").doc(playId);

  // Atomically claim the settlement: only one invocation can win the
  // locked -> settling transition. Also enforces CLAUDE.md rule #5 — a play
  // cannot settle before the previous one has settled or been voided.
  const claimed = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(playRef);
    const data = snap.data() as Play | undefined;
    if (!data || data.state !== "locked" || !data.result) return false;

    const prevId = adjacentPlayId(playId, -1);
    if (prevId) {
      const prevSnap = await tx.get(gameRef.collection("plays").doc(prevId));
      const prev = prevSnap.data() as Play | undefined;
      if (prev && prev.state !== "settled" && prev.state !== "voided") {
        throw new Error(`Refusing to settle ${playId}: previous play ${prevId} is still ${prev.state}.`);
      }
    }

    tx.update(playRef, { state: "settling" });
    return true;
  });
  if (!claimed) {
    logger.info("settlePlayHandler: no-op (already claimed/settled or state moved on)", { gameId, playId });
    return;
  }
  logger.info("settlePlayHandler: claimed", { gameId, playId });

  const game = (await gameRef.get()).data() as Game | undefined;
  if (!game) throw new Error(`Game ${gameId} not found while settling ${playId}.`);

  const play = (await playRef.get()).data() as Play;
  if (!play.snapAt) throw new Error(`Play ${playId} has no snapAt; cannot compute cutoff.`);
  const cutoffAt = Timestamp.fromMillis(play.snapAt.toMillis() - game.config.lockWindowSeconds * 1000);

  const wagersSnap = await playRef.collection("wagers").get();
  const revisions = wagersSnap.docs.map((doc) => {
    const data = doc.data() as WagerRevision;
    return {
      playerUid: data.playerUid,
      typePick: data.typePick,
      bucketPick: data.bucketPick,
      typeStake: data.typeStake,
      resultStake: data.resultStake,
      placedAtMillis: data.placedAt.toMillis(),
    };
  });
  const counted = selectCountedWagers(revisions, cutoffAt.toMillis());
  const uids = [...counted.keys()];
  logger.info("settlePlayHandler: wagers counted", {
    gameId,
    playId,
    revisionCount: revisions.length,
    countedCount: uids.length,
  });

  const playerRefs = new Map(uids.map((uid) => [uid, gameRef.collection("players").doc(uid)] as const));
  const playerSnaps = await Promise.all(uids.map((uid) => playerRefs.get(uid)!.get()));
  const balances = new Map<string, number>(
    uids.map((uid, i) => [uid, (playerSnaps[i].data() as Player | undefined)?.balance ?? 0]),
  );
  const clampedWagers = new Map(
    uids.map((uid) => [uid, clampStakeToBalance(counted.get(uid)!, balances.get(uid)!)] as const),
  );

  const summary = computeSettlement(clampedWagers, play.result!);
  logger.info("settlePlayHandler: settlement computed", {
    gameId,
    playId,
    result: play.result,
    typePool: summary.typePool,
    resultPool: summary.resultPool,
    typeWinners: summary.typeWinners,
    resultWinners: summary.resultWinners,
  });

  for (const batchPlayers of chunk(summary.players, 200)) {
    const batch = firestore.batch();
    for (const p of batchPlayers) {
      const balanceAfter = (balances.get(p.playerUid) ?? 0) + p.delta;
      batch.update(playerRefs.get(p.playerUid)!, {
        balance: balanceAfter,
        "stats.typeBets": FieldValue.increment(1),
        "stats.typeCorrect": FieldValue.increment(p.typeCorrect ? 1 : 0),
        "stats.typeWrong": FieldValue.increment(p.typeCorrect ? 0 : 1),
        "stats.resultCorrect": FieldValue.increment(p.resultCorrect ? 1 : 0),
      });

      const ledgerEntry: LedgerEntry = {
        delta: p.delta,
        balanceAfter,
        reason: "settlement",
        playerUid: p.playerUid,
        playId,
        createdAt: FieldValue.serverTimestamp() as unknown as Timestamp,
      };
      batch.set(gameRef.collection("ledger").doc(`${playId}_${p.playerUid}`), ledgerEntry);
    }
    await batch.commit();
  }

  // DESIGN.md §12.4 — reporting-accuracy bonuses/penalties, applied on top
  // of the settlement deltas. No-op for operator-driven games (no reports).
  const settledBalances = new Map(balances);
  for (const p of summary.players) {
    settledBalances.set(p.playerUid, (settledBalances.get(p.playerUid) ?? 0) + p.delta);
  }
  await applyReportingLedger(firestore, gameId, playId, game, play.result!, clampedWagers, settledBalances);

  await playRef.update({
    state: "settled",
    cutoffAt,
    settlement: {
      typePool: summary.typePool,
      resultPool: summary.resultPool,
      typeWinners: summary.typeWinners,
      resultWinners: summary.resultWinners,
      settledAt: FieldValue.serverTimestamp(),
    },
  });

  // Idempotent: if the next play already exists (e.g. this is a
  // re-settlement after an undo rewound currentPlayId back here), don't
  // clobber it or any wagers already sitting in it — just point the game
  // at it again.
  const nextPlayId = adjacentPlayId(playId, 1)!;
  const nextPlayRef = gameRef.collection("plays").doc(nextPlayId);
  if (!(await nextPlayRef.get()).exists) {
    await nextPlayRef.set({ state: "open", openedAt: FieldValue.serverTimestamp() });
  }
  await gameRef.update({ currentPlayId: nextPlayId });

  await recomputeLeaderboard(firestore, gameId);
  logger.info("settlePlayHandler: done", { gameId, playId, nextPlayId });
}

/**
 * DESIGN.md §3: VOID refunds by construction (deduct-at-settlement means a
 * voided play's stakes were never deducted in the first place — there's
 * nothing to money-move here); this just advances the game to the next play.
 */
export async function advanceAfterVoidHandler(firestore: Firestore, gameId: string, playId: string): Promise<void> {
  const gameRef = firestore.doc(`games/${gameId}`);
  const nextPlayId = adjacentPlayId(playId, 1)!;

  const advanced = await firestore.runTransaction(async (tx) => {
    const gameSnap = await tx.get(gameRef);
    const game = gameSnap.data() as Game | undefined;
    if (!game || game.currentPlayId !== playId) return false; // already advanced past this void

    tx.set(gameRef.collection("plays").doc(nextPlayId), {
      state: "open",
      openedAt: FieldValue.serverTimestamp(),
    });
    tx.update(gameRef, { currentPlayId: nextPlayId });
    return true;
  });

  logger.info(advanced ? "advanceAfterVoidHandler: advanced" : "advanceAfterVoidHandler: no-op", {
    gameId,
    playId,
    nextPlayId,
  });
}

/**
 * DESIGN.md §3/§7.2: reverses the most recent settled play only. Reverses
 * via the ledger (§6), not by recomputing settlement math, so the reversal
 * amount is exactly what was actually applied. Rewinds `currentPlayId` back
 * to the corrected play so the operator's normal "enter result" flow (which
 * always targets currentPlayId) can re-enter it.
 */
export async function undoLastSettlementHandler(
  firestore: Firestore,
  gameId: string,
  playId: string,
  uid: string,
  isMonitor = false,
): Promise<{ undone: number }> {
  const gameRef = firestore.doc(`games/${gameId}`);
  const playRef = gameRef.collection("plays").doc(playId);

  const game = (await gameRef.get()).data() as Game | undefined;
  if (!game) throw new HttpsError("not-found", "Game not found.");
  // §12.9: undo authority is the monitor claim under crowd operation;
  // operatorUids keeps working for operator-driven games during transition.
  if (!isMonitor && !game.operatorUids.includes(uid)) {
    logger.warn("undoLastSettlementHandler: rejected non-operator", { gameId, playId, uid });
    throw new HttpsError("permission-denied", "Only operators may undo a settlement.");
  }

  const play = (await playRef.get()).data() as Play | undefined;
  if (!play || play.state !== "settled" || !play.settlement || !play.result) {
    logger.warn("undoLastSettlementHandler: rejected, play not settled", { gameId, playId, state: play?.state });
    throw new HttpsError("failed-precondition", "Play is not in a settled state.");
  }
  if (play.settlement.reversedBy) {
    logger.warn("undoLastSettlementHandler: rejected, already undone", { gameId, playId });
    throw new HttpsError("failed-precondition", "This play was already undone.");
  }

  const nextPlayId = adjacentPlayId(playId, 1);
  if (nextPlayId) {
    const next = (await gameRef.collection("plays").doc(nextPlayId).get()).data() as Play | undefined;
    if (next && next.state !== "open") {
      logger.warn("undoLastSettlementHandler: rejected, later play already progressed", {
        gameId,
        playId,
        nextPlayId,
        nextState: next.state,
      });
      throw new HttpsError(
        "failed-precondition",
        "A later play has already progressed — only the latest play is undoable here.",
      );
    }
  }

  // Reporting bonuses/penalties (§12.4) ride the same play, so undo reverses
  // them alongside the settlement entries.
  const ledgerSnap = await gameRef
    .collection("ledger")
    .where("playId", "==", playId)
    .where("reason", "in", ["settlement", "reporting_bonus", "reporting_penalty"])
    .get();

  const wagersSnap = await playRef.collection("wagers").get();
  const latestWagerByPlayer = new Map<string, WagerRevision>();
  for (const doc of wagersSnap.docs) {
    const data = doc.data() as WagerRevision;
    const existing = latestWagerByPlayer.get(data.playerUid);
    if (!existing || data.placedAt.toMillis() > existing.placedAt.toMillis()) {
      latestWagerByPlayer.set(data.playerUid, data);
    }
  }

  for (const batchDocs of chunk(ledgerSnap.docs, 200)) {
    const batch = firestore.batch();
    for (const doc of batchDocs) {
      const entry = doc.data() as LedgerEntry;
      if (entry.reason === "settlement") {
        const wager = latestWagerByPlayer.get(entry.playerUid);
        const typeCorrect = wager?.typePick === play.result!.type;
        const resultCorrect = typeCorrect && wager?.bucketPick === play.result!.bucket;
        batch.update(gameRef.collection("players").doc(entry.playerUid), {
          balance: FieldValue.increment(-entry.delta),
          "stats.typeBets": FieldValue.increment(-1),
          "stats.typeCorrect": FieldValue.increment(typeCorrect ? -1 : 0),
          "stats.typeWrong": FieldValue.increment(typeCorrect ? 0 : -1),
          "stats.resultCorrect": FieldValue.increment(resultCorrect ? -1 : 0),
        });
      } else {
        // Reporting entries carry no stats — reverse the balance only.
        batch.update(gameRef.collection("players").doc(entry.playerUid), {
          balance: FieldValue.increment(-entry.delta),
        });
      }

      const undoEntry: LedgerEntry = {
        delta: -entry.delta,
        balanceAfter: entry.balanceAfter - entry.delta,
        reason: "undo",
        playerUid: entry.playerUid,
        playId,
        createdAt: FieldValue.serverTimestamp() as unknown as Timestamp,
      };
      batch.set(gameRef.collection("ledger").doc(`${doc.id}_undo`), undoEntry);
    }
    await batch.commit();
  }

  const finalBatch = firestore.batch();
  finalBatch.update(playRef, {
    state: "locked",
    result: FieldValue.delete(),
    "settlement.reversedBy": `undo_${Date.now()}`,
  });
  finalBatch.update(gameRef, { currentPlayId: playId });
  await finalBatch.commit();

  await recomputeLeaderboard(firestore, gameId);
  logger.info("undoLastSettlementHandler: done", { gameId, playId, uid, undone: ledgerSnap.size });

  return { undone: ledgerSnap.size };
}
