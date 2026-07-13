// Integration tests against the real Firestore emulator — exercises actual
// reads/writes/transactions/batches, not just the pure math in
// settlement.test.ts. Run via `npm run test:emulator` (wraps this file with
// `firebase emulators:exec`); excluded from the default `vitest run` (see
// vitest.config.ts) since a bare `npx vitest run` has no emulator to talk to.

import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";
import { advanceAfterVoidHandler, settlePlayHandler, undoLastSettlementHandler } from "./handlers";
import { clearFirestoreEmulator, getTestFirestore } from "./emulator-test-utils";
import type { Game, LedgerEntry, Leaderboard, Play, Player } from "./types";

const db = getTestFirestore();
const GAME_ID = "test-game";

function ts(millis: number): Timestamp {
  return Timestamp.fromMillis(millis);
}

async function seedGame(overrides: Partial<Game> = {}): Promise<void> {
  const game: Game = {
    status: "live",
    config: {
      lockWindowSeconds: 10,
      grubstake: 1000,
      minStake: 1,
      buckets: { run: ["loss", "0", "1", "2", "3", "4", "5+"], pass: ["interception", "sack", "0", "16+"] },
      bustedTopUp: false,
    },
    currentPlayId: "0001",
    period: "Q1",
    operatorUids: ["operator-1"],
    ...overrides,
  };
  await db.doc(`games/${GAME_ID}`).set(game);
}

async function seedPlayer(uid: string, balance: number): Promise<void> {
  const player: Player = {
    displayName: uid,
    balance,
    stats: { typeBets: 0, typeCorrect: 0, typeWrong: 0, resultCorrect: 0 },
  };
  await db.doc(`games/${GAME_ID}/players/${uid}`).set(player);
}

async function seedPlay(playId: string, play: Partial<Play>): Promise<void> {
  await db.doc(`games/${GAME_ID}/plays/${playId}`).set({
    state: "open",
    openedAt: ts(0),
    ...play,
  });
}

async function seedWager(
  playId: string,
  playerUid: string,
  typePick: "run" | "pass",
  bucketPick: string,
  typeStake: number,
  resultStake: number,
  placedAtMillis: number,
): Promise<void> {
  await db.doc(`games/${GAME_ID}/plays/${playId}/wagers/${playerUid}-${placedAtMillis}`).set({
    playerUid,
    typePick,
    bucketPick,
    typeStake,
    resultStake,
    placedAt: ts(placedAtMillis),
  });
}

async function getPlayer(uid: string): Promise<Player> {
  const snap = await db.doc(`games/${GAME_ID}/players/${uid}`).get();
  return snap.data() as Player;
}

async function getPlay(playId: string): Promise<Play> {
  const snap = await db.doc(`games/${GAME_ID}/plays/${playId}`).get();
  return snap.data() as Play;
}

async function getGame(): Promise<Game> {
  const snap = await db.doc(`games/${GAME_ID}`).get();
  return snap.data() as Game;
}

async function getLedgerEntries(playId: string): Promise<LedgerEntry[]> {
  const snap = await db.collection(`games/${GAME_ID}/ledger`).where("playId", "==", playId).get();
  return snap.docs.map((d) => d.data() as LedgerEntry);
}

async function getLeaderboard(): Promise<Leaderboard | undefined> {
  const snap = await db.doc(`games/${GAME_ID}/public/leaderboard`).get();
  return snap.data() as Leaderboard | undefined;
}

beforeEach(async () => {
  await clearFirestoreEmulator();
});

describe("settlePlayHandler", () => {
  it("settles the DESIGN.md §4.3 worked example end-to-end", async () => {
    const SNAP_MILLIS = 100_000;
    await seedGame();
    await seedPlayer("A", 1000);
    await seedPlayer("B", 1000);
    await seedPlayer("C", 1000);
    await seedPlayer("D", 1000);
    await seedPlay("0001", {
      state: "locked",
      snapAt: ts(SNAP_MILLIS),
      result: { type: "run", bucket: "3" },
    });
    // All placed well before the 10s cutoff.
    await seedWager("0001", "A", "run", "3", 100, 0, SNAP_MILLIS - 20_000);
    await seedWager("0001", "B", "run", "1", 50, 0, SNAP_MILLIS - 20_000);
    await seedWager("0001", "C", "pass", "0", 200, 0, SNAP_MILLIS - 20_000);
    await seedWager("0001", "D", "pass", "sack", 50, 0, SNAP_MILLIS - 20_000);

    await settlePlayHandler(db, GAME_ID, "0001");

    expect((await getPlayer("A")).balance).toBe(1000 - 100 + 266);
    expect((await getPlayer("B")).balance).toBe(1000 - 50 + 133);
    expect((await getPlayer("C")).balance).toBe(1000 - 200);
    expect((await getPlayer("D")).balance).toBe(1000 - 50);

    const play = await getPlay("0001");
    expect(play.state).toBe("settled");
    expect(play.settlement?.typePool).toBe(400);
    expect(play.settlement?.typeWinners).toBe(2);

    const nextPlay = await getPlay("0002");
    expect(nextPlay.state).toBe("open");
    expect((await getGame()).currentPlayId).toBe("0002");

    const ledger = await getLedgerEntries("0001");
    expect(ledger).toHaveLength(4);
    expect(ledger.find((e) => e.playerUid === "A")?.delta).toBe(166);
    expect(ledger.find((e) => e.playerUid === "C")?.delta).toBe(-200);

    // DESIGN.md §8: recomputed as part of settlement.
    const leaderboard = await getLeaderboard();
    expect(leaderboard?.topBalance[0].uid).toBe("A");
    expect(leaderboard?.topBalance[0].balance).toBe(1166);
    expect(leaderboard?.accuracy.mode).toBe("top5"); // only 4 players total, well under the perfect-count threshold
    expect(leaderboard?.accuracy.entries?.map((e) => e.uid).sort()).toEqual(["A", "B", "C", "D"]);
    expect(leaderboard?.accuracy.entries?.find((e) => e.uid === "A")?.wrong).toBe(0);
    expect(leaderboard?.accuracy.entries?.find((e) => e.uid === "C")?.wrong).toBe(1);
  });

  it("excludes a wager revision placed after the retroactive cutoff", async () => {
    const SNAP_MILLIS = 100_000;
    await seedGame();
    await seedPlayer("A", 1000);
    await seedPlay("0001", {
      state: "locked",
      snapAt: ts(SNAP_MILLIS),
      result: { type: "run", bucket: "3" },
    });
    // First (valid) pick, then a late change after the cutoff that must not count.
    await seedWager("0001", "A", "run", "3", 100, 0, SNAP_MILLIS - 20_000);
    await seedWager("0001", "A", "pass", "sack", 999, 0, SNAP_MILLIS - 1_000); // inside 10s window, after cutoff

    await settlePlayHandler(db, GAME_ID, "0001");

    // The late revision must not apply — A's counted stake is still the
    // first (run/3) pick, which wins solo (degenerate case: stake back).
    expect((await getPlayer("A")).balance).toBe(1000);
  });

  it("refuses to settle a play out of sequence", async () => {
    await seedGame({ currentPlayId: "0002" });
    await seedPlay("0001", { state: "open" }); // previous play never settled or voided
    await seedPlay("0002", {
      state: "locked",
      snapAt: ts(100_000),
      result: { type: "run", bucket: "0" },
    });

    await expect(settlePlayHandler(db, GAME_ID, "0002")).rejects.toThrow(/still open/);
  });

  it("is idempotent — calling it twice on an already-settled play is a no-op", async () => {
    await seedGame();
    await seedPlayer("A", 1000);
    await seedPlay("0001", {
      state: "locked",
      snapAt: ts(100_000),
      result: { type: "run", bucket: "0" },
    });
    await seedWager("0001", "A", "run", "0", 100, 0, 80_000);

    await settlePlayHandler(db, GAME_ID, "0001");
    const balanceAfterFirst = (await getPlayer("A")).balance;

    await settlePlayHandler(db, GAME_ID, "0001");
    expect((await getPlayer("A")).balance).toBe(balanceAfterFirst);
  });

  it("recovers a play stuck in 'settling' (simulated crash mid-settlement) without double-paying", async () => {
    await seedGame();
    await seedPlayer("A", 1000);
    await seedPlayer("B", 1000);
    await seedPlay("0001", {
      state: "settling", // as if a prior invocation claimed it and then died
      snapAt: ts(100_000),
      result: { type: "run", bucket: "0" },
    });
    await seedWager("0001", "A", "run", "0", 100, 0, 80_000); // wins
    await seedWager("0001", "B", "pass", "0", 100, 0, 80_000); // loses

    // Simulate that A's payout was already committed by the dead attempt
    // (deterministic ledger doc, absolute balance, incremented stats) but
    // B's was not — a batch.commit() landed for A before the crash.
    await db.doc(`games/${GAME_ID}/players/A`).update({
      balance: 1100,
      "stats.typeBets": 1,
      "stats.typeCorrect": 1,
    });
    await db.doc(`games/${GAME_ID}/ledger/0001_A`).set({
      delta: 100,
      balanceAfter: 1100,
      reason: "settlement",
      playerUid: "A",
      playId: "0001",
      createdAt: ts(50_000),
    });

    await settlePlayHandler(db, GAME_ID, "0001");

    // A must not be paid or scored a second time; B's payout must still land.
    const playerA = await getPlayer("A");
    expect(playerA.balance).toBe(1100);
    expect(playerA.stats.typeBets).toBe(1);
    const playerB = await getPlayer("B");
    expect(playerB.balance).toBe(900);
    expect(playerB.stats.typeBets).toBe(1);
    expect(playerB.stats.typeWrong).toBe(1);
    expect((await getPlay("0001")).state).toBe("settled");
    expect((await getLedgerEntries("0001")).length).toBe(2);
  });
});

describe("advanceAfterVoidHandler", () => {
  it("opens the next play and advances currentPlayId, with no money movement", async () => {
    await seedGame({ currentPlayId: "0001" });
    await seedPlayer("A", 1000);
    await seedPlay("0001", { state: "voided" });

    await advanceAfterVoidHandler(db, GAME_ID, "0001");

    expect((await getPlay("0002")).state).toBe("open");
    expect((await getGame()).currentPlayId).toBe("0002");
    expect((await getPlayer("A")).balance).toBe(1000);
  });

  it("is idempotent — a second call after currentPlayId already advanced is a no-op", async () => {
    await seedGame({ currentPlayId: "0001" });
    await seedPlay("0001", { state: "voided" });

    await advanceAfterVoidHandler(db, GAME_ID, "0001");
    await advanceAfterVoidHandler(db, GAME_ID, "0001"); // currentPlayId is now "0002", not "0001"

    expect((await getGame()).currentPlayId).toBe("0002");
  });
});

describe("undoLastSettlementHandler", () => {
  async function settleASimplePlay() {
    await seedGame({ currentPlayId: "0001", operatorUids: ["op-1"] });
    await seedPlayer("A", 1000);
    await seedPlayer("B", 1000);
    await seedPlay("0001", {
      state: "locked",
      snapAt: ts(100_000),
      result: { type: "run", bucket: "0" },
    });
    await seedWager("0001", "A", "run", "0", 100, 0, 80_000);
    await seedWager("0001", "B", "pass", "0", 100, 0, 80_000);
    await settlePlayHandler(db, GAME_ID, "0001");
  }

  it("reverses balances and stats, and rewinds currentPlayId to the corrected play", async () => {
    await settleASimplePlay();
    const balanceABeforeUndo = (await getPlayer("A")).balance;
    const balanceBBeforeUndo = (await getPlayer("B")).balance;
    // Sanity: settlement actually moved money for both players.
    expect(balanceABeforeUndo).not.toBe(1000);
    expect(balanceBBeforeUndo).not.toBe(1000);

    const result = await undoLastSettlementHandler(db, GAME_ID, "0001", "op-1");
    expect(result.undone).toBe(2);

    expect((await getPlayer("A")).balance).toBe(1000);
    expect((await getPlayer("B")).balance).toBe(1000);
    expect((await getPlayer("A")).stats.typeBets).toBe(0);

    const play = await getPlay("0001");
    expect(play.state).toBe("locked");
    expect(play.result).toBeUndefined();
    expect(play.settlement?.reversedBy).toBeTruthy();

    expect((await getGame()).currentPlayId).toBe("0001");

    // DESIGN.md §8: recomputed after undo too, since stats reverted.
    const leaderboard = await getLeaderboard();
    expect(leaderboard?.accuracy.entries?.every((e) => e.wrong === 0)).toBe(true);
  });

  it("rejects a non-operator", async () => {
    await settleASimplePlay();
    await expect(undoLastSettlementHandler(db, GAME_ID, "0001", "not-an-operator")).rejects.toThrow(
      /Only operators/,
    );
  });

  it("rejects undoing an already-undone play", async () => {
    await settleASimplePlay();
    await undoLastSettlementHandler(db, GAME_ID, "0001", "op-1");
    await expect(undoLastSettlementHandler(db, GAME_ID, "0001", "op-1")).rejects.toThrow(/not in a settled state/);
  });

  it("rejects undoing when a later play has already progressed", async () => {
    await settleASimplePlay();
    await db.doc(`games/${GAME_ID}/plays/0002`).update({ state: "locked", snapAt: ts(200_000) });

    await expect(undoLastSettlementHandler(db, GAME_ID, "0001", "op-1")).rejects.toThrow(/already progressed/);
  });

  it("reverses stats using the counted (pre-cutoff) wager, not whatever revision is latest", async () => {
    // A's counted pick (run/"0", placed well before the cutoff) wins; A then
    // changes their mind to pass/"sack" *after* the cutoff but before SNAP —
    // legal (the play is still "open" until SNAP), and that later revision is
    // what stands as "latest" even though it never counted for scoring.
    await seedGame({ currentPlayId: "0001", operatorUids: ["op-1"] });
    await seedPlayer("A", 1000);
    await seedPlay("0001", {
      state: "locked",
      snapAt: ts(100_000), // cutoff = 100_000 - 10_000 = 90_000
      result: { type: "run", bucket: "0" },
    });
    await seedWager("0001", "A", "run", "0", 100, 0, 80_000); // counted: correct pick
    await seedWager("0001", "A", "pass", "sack", 100, 0, 95_000); // latest, but after cutoff: doesn't count

    await settlePlayHandler(db, GAME_ID, "0001");
    const settled = await getPlayer("A");
    expect(settled.stats.typeCorrect).toBe(1); // scored on the counted (run) pick
    expect(settled.stats.resultCorrect).toBe(1);

    await undoLastSettlementHandler(db, GAME_ID, "0001", "op-1");

    const undone = await getPlayer("A");
    expect(undone.balance).toBe(1000);
    expect(undone.stats.typeBets).toBe(0);
    expect(undone.stats.typeCorrect).toBe(0);
    expect(undone.stats.typeWrong).toBe(0);
    expect(undone.stats.resultCorrect).toBe(0);
  });

  it("recomputes the public leaderboard doc to reflect the reversed stats", async () => {
    await settleASimplePlay();
    await undoLastSettlementHandler(db, GAME_ID, "0001", "op-1");

    const leaderboard = await getLeaderboard();
    expect(leaderboard?.topBalance.find((e) => e.uid === "A")?.balance).toBe(1000);
    expect(leaderboard?.topBalance.find((e) => e.uid === "B")?.balance).toBe(1000);
    expect(leaderboard?.accuracy.entries?.every((e) => e.wrong === 0)).toBe(true);
  });
});
