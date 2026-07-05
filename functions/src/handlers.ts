// The actual business logic behind each Cloud Function, separated from the
// trigger/event glue in index.ts so it can be exercised directly against
// the Firestore emulator in tests — no need to simulate CloudEvents or run
// the Functions emulator to test what these do to Firestore state.

import { FieldValue, Firestore, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { adjacentPlayId, clampStakeToBalance, computeSettlement, selectCountedWagers } from "./settlement";
import type { Game, LedgerEntry, Play, Player, WagerRevision } from "./types";

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
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
  if (!claimed) return;

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

  const playerRefs = new Map(uids.map((uid) => [uid, gameRef.collection("players").doc(uid)] as const));
  const playerSnaps = await Promise.all(uids.map((uid) => playerRefs.get(uid)!.get()));
  const balances = new Map<string, number>(
    uids.map((uid, i) => [uid, (playerSnaps[i].data() as Player | undefined)?.balance ?? 0]),
  );
  const clampedWagers = new Map(
    uids.map((uid) => [uid, clampStakeToBalance(counted.get(uid)!, balances.get(uid)!)] as const),
  );

  const summary = computeSettlement(clampedWagers, play.result!);

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
}

/**
 * DESIGN.md §3: VOID refunds by construction (deduct-at-settlement means a
 * voided play's stakes were never deducted in the first place — there's
 * nothing to money-move here); this just advances the game to the next play.
 */
export async function advanceAfterVoidHandler(firestore: Firestore, gameId: string, playId: string): Promise<void> {
  const gameRef = firestore.doc(`games/${gameId}`);
  const nextPlayId = adjacentPlayId(playId, 1)!;

  await firestore.runTransaction(async (tx) => {
    const gameSnap = await tx.get(gameRef);
    const game = gameSnap.data() as Game | undefined;
    if (!game || game.currentPlayId !== playId) return; // already advanced past this void

    tx.set(gameRef.collection("plays").doc(nextPlayId), {
      state: "open",
      openedAt: FieldValue.serverTimestamp(),
    });
    tx.update(gameRef, { currentPlayId: nextPlayId });
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
): Promise<{ undone: number }> {
  const gameRef = firestore.doc(`games/${gameId}`);
  const playRef = gameRef.collection("plays").doc(playId);

  const game = (await gameRef.get()).data() as Game | undefined;
  if (!game) throw new HttpsError("not-found", "Game not found.");
  if (!game.operatorUids.includes(uid)) {
    throw new HttpsError("permission-denied", "Only operators may undo a settlement.");
  }

  const play = (await playRef.get()).data() as Play | undefined;
  if (!play || play.state !== "settled" || !play.settlement || !play.result) {
    throw new HttpsError("failed-precondition", "Play is not in a settled state.");
  }
  if (play.settlement.reversedBy) {
    throw new HttpsError("failed-precondition", "This play was already undone.");
  }

  const nextPlayId = adjacentPlayId(playId, 1);
  if (nextPlayId) {
    const next = (await gameRef.collection("plays").doc(nextPlayId).get()).data() as Play | undefined;
    if (next && next.state !== "open") {
      throw new HttpsError(
        "failed-precondition",
        "A later play has already progressed — only the latest play is undoable here.",
      );
    }
  }

  const ledgerSnap = await gameRef
    .collection("ledger")
    .where("playId", "==", playId)
    .where("reason", "==", "settlement")
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

      const undoEntry: LedgerEntry = {
        delta: -entry.delta,
        balanceAfter: entry.balanceAfter - entry.delta,
        reason: "undo",
        playerUid: entry.playerUid,
        playId,
        createdAt: FieldValue.serverTimestamp() as unknown as Timestamp,
      };
      batch.set(gameRef.collection("ledger").doc(`${playId}_${entry.playerUid}_undo`), undoEntry);
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

  return { undone: ledgerSnap.size };
}
