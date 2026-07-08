// Integration tests for the crowd-run handlers (DESIGN.md §12 / PLAN.md
// CR-2) against the real Firestore emulator. The exit criterion from
// PLAN.md: a complete play driven entirely by synthetic crowd input — no
// operator writes anywhere — plus the failure/fallback paths (quorum void,
// grace-period holds, shadow mode leaving state untouched).

import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cancelHoldHandler,
  handleMomentSignal,
  handleReport,
  monitorVoidPlayHandler,
  scheduleGameHandler,
  sweepCrowdGames,
} from "./crowdHandlers";
import { advanceAfterVoidHandler, settlePlayHandler, undoLastSettlementHandler } from "./handlers";
import { clearFirestoreEmulator, getTestFirestore } from "./emulator-test-utils";
import type { Game, GameConfig, LedgerEntry, Play, Player } from "./types";

const db = getTestFirestore();
const GAME_ID = "crowd-game";

function ts(millis: number): Timestamp {
  return Timestamp.fromMillis(millis);
}

// Small-crowd tunables so tests stay readable: 3 snap pressers, 2 moment
// pressers, quorum floor 3. stakeConcentrationCapFraction is high so the
// concentration flag only fires in the test that targets it.
function crowdConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    lockWindowSeconds: 10,
    grubstake: 1000,
    minStake: 1,
    buckets: {
      run: ["loss", "0", "1", "2", "3", "4", "5+"],
      pass: ["incomplete", "intercepted", "sack", "scramble", "<5", "5-7", "8-10", "11-15", "16-20", "21+"],
    },
    bustedTopUp: false,
    crowdMode: "live",
    snapBurstWindowSeconds: 2,
    snapBurstMinReports: 3,
    momentBurstMinReports: 2,
    endGameGraceSeconds: 120,
    typeVoteStableShare: 0.8,
    voteStabilitySeconds: 3,
    typeVoteTimeoutSeconds: 20,
    resultVoteTimeoutSeconds: 40,
    reportQuorumMin: 3,
    reportQuorumShare: 0.6,
    reportMarginAutoTrust: 0.65,
    reportMarginSuspicious: 0.75,
    reportingBonusCredits: 3,
    stakeConcentrationCapFraction: 100,
    ...overrides,
  };
}

async function seedGame(game: Partial<Game> = {}, config: Partial<GameConfig> = {}): Promise<void> {
  await db.doc(`games/${GAME_ID}`).set({
    status: "live",
    config: crowdConfig(config),
    currentPlayId: "0001",
    period: "Q1",
    operatorUids: ["scheduler-1"],
    ...game,
  });
}

async function seedPlayer(uid: string, balance = 1000): Promise<void> {
  await db.doc(`games/${GAME_ID}/players/${uid}`).set({
    displayName: uid,
    balance,
    stats: { typeBets: 0, typeCorrect: 0, typeWrong: 0, resultCorrect: 0 },
  });
}

async function seedPlay(playId: string, play: Partial<Play> = {}): Promise<void> {
  await db.doc(`games/${GAME_ID}/plays/${playId}`).set({ state: "open", openedAt: ts(0), ...play });
}

async function seedWager(
  playId: string,
  uid: string,
  typePick: "run" | "pass",
  bucketPick: string,
  typeStake: number,
  resultStake: number,
  placedAtMillis: number,
): Promise<void> {
  await db.doc(`games/${GAME_ID}/plays/${playId}/wagers/${uid}-${placedAtMillis}`).set({
    playerUid: uid,
    typePick,
    bucketPick,
    typeStake,
    resultStake,
    placedAt: ts(placedAtMillis),
  });
}

async function seedSnapReport(playId: string, uid: string, atMillis: number): Promise<void> {
  await db.doc(`games/${GAME_ID}/plays/${playId}/reports/snap-${uid}-${atMillis}`).set({
    playerUid: uid,
    phase: "snap",
    value: "",
    reportedAt: ts(atMillis),
  });
}

async function seedVoteReport(
  playId: string,
  uid: string,
  phase: "type" | "result",
  value: string,
  atMillis: number,
): Promise<void> {
  await db.doc(`games/${GAME_ID}/plays/${playId}/reports/${phase}-${uid}-${atMillis}`).set({
    playerUid: uid,
    phase,
    value,
    reportedAt: ts(atMillis),
  });
}

async function seedMomentSignal(uid: string, momentType: string, atMillis: number): Promise<void> {
  await db.doc(`games/${GAME_ID}/momentSignals/${momentType}-${uid}-${atMillis}`).set({
    playerUid: uid,
    momentType,
    signaledAt: ts(atMillis),
  });
}

async function getGame(): Promise<Game> {
  return (await db.doc(`games/${GAME_ID}`).get()).data() as Game;
}

async function getPlay(playId: string): Promise<Play> {
  return (await db.doc(`games/${GAME_ID}/plays/${playId}`).get()).data() as Play;
}

async function getPlayer(uid: string): Promise<Player> {
  return (await db.doc(`games/${GAME_ID}/players/${uid}`).get()).data() as Player;
}

beforeEach(async () => {
  await clearFirestoreEmulator();
});

describe("snap burst (§12.2)", () => {
  it("locks the play at the burst moment with snapAt derived from server-timestamped signals", async () => {
    await seedGame();
    await seedPlay("0001");
    await seedSnapReport("0001", "a", 100_000);
    await seedSnapReport("0001", "b", 100_400);
    await seedSnapReport("0001", "c", 100_900);

    await handleReport(db, GAME_ID, "0001", 101_000);

    const play = await getPlay("0001");
    expect(play.state).toBe("locked");
    expect(play.snapAt?.toMillis()).toBe(100_900); // the threshold-crossing press
  });

  it("does not lock below the burst threshold", async () => {
    await seedGame();
    await seedPlay("0001");
    await seedSnapReport("0001", "a", 100_000);
    await seedSnapReport("0001", "b", 100_400);

    await handleReport(db, GAME_ID, "0001", 101_000);

    expect((await getPlay("0001")).state).toBe("open");
  });

  it("repeat presses from one uid don't count as a burst", async () => {
    await seedGame();
    await seedPlay("0001");
    await seedSnapReport("0001", "a", 100_000);
    await seedSnapReport("0001", "a", 100_300);
    await seedSnapReport("0001", "a", 100_600);

    await handleReport(db, GAME_ID, "0001", 101_000);

    expect((await getPlay("0001")).state).toBe("open");
  });

  it("shadow mode records the would-be snap and leaves the play untouched", async () => {
    await seedGame({}, { crowdMode: "shadow" });
    await seedPlay("0001");
    await seedSnapReport("0001", "a", 100_000);
    await seedSnapReport("0001", "b", 100_400);
    await seedSnapReport("0001", "c", 100_900);

    await handleReport(db, GAME_ID, "0001", 101_000);

    expect((await getPlay("0001")).state).toBe("open");
    const shadow = await db.doc(`games/${GAME_ID}/shadowDecisions/snap_0001`).get();
    expect(shadow.exists).toBe(true);
    expect(shadow.data()?.burstAtMillis).toBe(100_900);
  });

  it("crowdMode off ignores reports entirely", async () => {
    await seedGame({}, { crowdMode: "off" });
    await seedPlay("0001");
    await seedSnapReport("0001", "a", 100_000);
    await seedSnapReport("0001", "b", 100_400);
    await seedSnapReport("0001", "c", 100_900);

    await handleReport(db, GAME_ID, "0001", 101_000);

    expect((await getPlay("0001")).state).toBe("open");
  });
});

describe("moment signals (§12.2)", () => {
  it("kickoff flips scheduled → live and opens the first play", async () => {
    await seedGame({ status: "scheduled" });
    await seedMomentSignal("a", "kickoff", 50_000);
    await seedMomentSignal("b", "kickoff", 50_500);

    await handleMomentSignal(db, GAME_ID, "kickoff", 51_000);

    expect((await getGame()).status).toBe("live");
    expect((await getPlay("0001")).state).toBe("open");
  });

  it("end_q1 advances the period only from Q1", async () => {
    await seedGame({ period: "Q1" });
    await seedMomentSignal("a", "end_q1", 50_000);
    await seedMomentSignal("b", "end_q1", 50_500);

    await handleMomentSignal(db, GAME_ID, "end_q1", 51_000);
    expect((await getGame()).period).toBe("Q2");

    // Re-running against the already-advanced game is a no-op (state gate).
    await handleMomentSignal(db, GAME_ID, "end_q1", 52_000);
    expect((await getGame()).period).toBe("Q2");
  });

  it("half sets halftime, and the next snap burst resumes live play", async () => {
    await seedGame({ period: "Q2" });
    await seedMomentSignal("a", "half", 50_000);
    await seedMomentSignal("b", "half", 50_500);
    await handleMomentSignal(db, GAME_ID, "half", 51_000);

    let game = await getGame();
    expect(game.status).toBe("halftime");
    expect(game.period).toBe("Q3");

    await seedPlay("0001");
    await seedSnapReport("0001", "a", 60_000);
    await seedSnapReport("0001", "b", 60_200);
    await seedSnapReport("0001", "c", 60_400);
    await handleReport(db, GAME_ID, "0001", 61_000);

    game = await getGame();
    expect(game.status).toBe("live");
    expect((await getPlay("0001")).state).toBe("locked");
  });

  it("end_game enters a grace hold, and the sweep finalizes it after expiry (§12.9)", async () => {
    await seedGame({ period: "Q4" });
    await seedMomentSignal("a", "end_game", 50_000);
    await seedMomentSignal("b", "end_game", 50_500);

    await handleMomentSignal(db, GAME_ID, "end_game", 51_000);

    let game = await getGame();
    expect(game.status).toBe("live"); // not final yet — held
    expect(game.endGameHoldType).toBe("end_game");
    expect(game.endGameHoldUntil?.toMillis()).toBe(51_000 + 120_000);

    // Sweep before expiry: nothing happens.
    await sweepCrowdGames(db, 60_000);
    expect((await getGame()).status).toBe("live");

    // Sweep after expiry: the crowd's call stands.
    await sweepCrowdGames(db, 171_001);
    game = await getGame();
    expect(game.status).toBe("final");
    expect(game.endGameHoldUntil).toBeUndefined();
  });

  it("the monitor can cancel a hold; non-monitors cannot (§12.9)", async () => {
    await seedGame({ period: "Q4" });
    await seedMomentSignal("a", "end_game", 50_000);
    await seedMomentSignal("b", "end_game", 50_500);
    await handleMomentSignal(db, GAME_ID, "end_game", 51_000);

    await expect(cancelHoldHandler(db, GAME_ID, false)).rejects.toThrow(/Only monitors/);

    await cancelHoldHandler(db, GAME_ID, true);
    const game = await getGame();
    expect(game.endGameHoldUntil).toBeUndefined();
    expect(game.status).toBe("live");

    // Expired-hold sweep after a cancel does nothing.
    await sweepCrowdGames(db, 999_999);
    expect((await getGame()).status).toBe("live");
  });

  it("commercial_enter/exit flip adMode, and stale signals don't re-trigger", async () => {
    await seedGame();
    await seedMomentSignal("a", "commercial_enter", 50_000);
    await seedMomentSignal("b", "commercial_enter", 50_500);
    await handleMomentSignal(db, GAME_ID, "commercial_enter", 51_000);
    expect((await getGame()).adMode).toBe("commercial");

    await seedMomentSignal("a", "commercial_exit", 60_000);
    await seedMomentSignal("b", "commercial_exit", 60_500);
    await handleMomentSignal(db, GAME_ID, "commercial_exit", 61_000);
    expect((await getGame()).adMode).toBe("game");

    // The old enter signals predate adModeChangedAt — no re-flip.
    await handleMomentSignal(db, GAME_ID, "commercial_enter", 62_000);
    expect((await getGame()).adMode).toBe("game");
  });

  it("shadow mode records moments without applying them", async () => {
    await seedGame({ period: "Q1" }, { crowdMode: "shadow" });
    await seedMomentSignal("a", "end_q1", 50_000);
    await seedMomentSignal("b", "end_q1", 50_500);

    await handleMomentSignal(db, GAME_ID, "end_q1", 51_000);

    expect((await getGame()).period).toBe("Q1");
    const shadow = await db.doc(`games/${GAME_ID}/shadowDecisions/end_q1_live_Q1`).get();
    expect(shadow.exists).toBe(true);
  });
});

describe("full crowd-run play (§12.3/§12.4) — PLAN.md CR-2 exit criterion", () => {
  const SNAP = 100_000;

  /**
   * Four players, all staked on both pools. A/C/D bet run/"3", B bets
   * pass/"<5". Crowd reports: type run 3-of-4 (B self-servingly says pass),
   * result "3" unanimously among valid reports (B's "<5" isn't a run bucket,
   * so it drops out of the vote but still counts for the §12.4 penalty).
   */
  async function runFullPlay(): Promise<void> {
    await seedGame();
    for (const uid of ["A", "B", "C", "D"]) await seedPlayer(uid);
    await seedPlay("0001");
    await seedWager("0001", "A", "run", "3", 100, 100, SNAP - 20_000);
    await seedWager("0001", "B", "pass", "<5", 100, 100, SNAP - 20_000);
    await seedWager("0001", "C", "run", "3", 100, 100, SNAP - 20_000);
    await seedWager("0001", "D", "run", "3", 100, 100, SNAP - 20_000);

    // Snap burst.
    await seedSnapReport("0001", "A", SNAP - 900);
    await seedSnapReport("0001", "B", SNAP - 500);
    await seedSnapReport("0001", "C", SNAP);
    await handleReport(db, GAME_ID, "0001", SNAP + 1_000);

    // Type + result votes.
    for (const uid of ["A", "C", "D"]) {
      await seedVoteReport("0001", uid, "type", "run", SNAP + 5_000);
      await seedVoteReport("0001", uid, "result", "3", SNAP + 8_000);
    }
    await seedVoteReport("0001", "B", "type", "pass", SNAP + 5_000);
    await seedVoteReport("0001", "B", "result", "<5", SNAP + 8_000);

    // Type share 0.75 < stable 0.8, so it finalizes at the type timeout.
    await handleReport(db, GAME_ID, "0001", SNAP + 21_000);
  }

  it("locks, votes, finalizes, settles, and pays reporting bonuses — zero operator writes", async () => {
    await runFullPlay();

    const play = await getPlay("0001");
    expect(play.snapAt?.toMillis()).toBe(SNAP);
    expect(play.typeOfficial).toBe("run");
    expect(play.resultOfficial).toBe("3");
    expect(play.result).toEqual({ type: "run", bucket: "3" });

    // The existing settlement path takes over (the trigger does this in
    // prod; tests invoke it directly).
    await settlePlayHandler(db, GAME_ID, "0001");

    // Parimutuel per pool: 400 pool, A/C/D split winning stakes 300 →
    // floor(400*100/300)=133 each, twice. B loses both stakes.
    // §12.4 on top: A/C/D +3 (type agree) +3 (result exact) = +6;
    // B −3 (type: reported pass, bet pass) −3 (result: far miss "<5"
    // matching own wager) = −6.
    expect((await getPlayer("A")).balance).toBe(1000 - 200 + 266 + 6);
    expect((await getPlayer("C")).balance).toBe(1000 - 200 + 266 + 6);
    expect((await getPlayer("D")).balance).toBe(1000 - 200 + 266 + 6);
    expect((await getPlayer("B")).balance).toBe(1000 - 200 - 6);

    const ledgerSnap = await db
      .collection(`games/${GAME_ID}/ledger`)
      .where("playId", "==", "0001")
      .get();
    const entries = ledgerSnap.docs.map((d) => d.data() as LedgerEntry);
    expect(entries.filter((e) => e.reason === "settlement")).toHaveLength(4);
    expect(entries.filter((e) => e.reason === "reporting_bonus")).toHaveLength(6); // A/C/D × 2 pools
    expect(entries.filter((e) => e.reason === "reporting_penalty")).toHaveLength(2); // B × 2 pools

    expect((await getPlay("0002")).state).toBe("open");
  });

  it("settlement retry doesn't double-pay reporting bonuses", async () => {
    await runFullPlay();
    await settlePlayHandler(db, GAME_ID, "0001");
    const balanceA = (await getPlayer("A")).balance;

    await settlePlayHandler(db, GAME_ID, "0001"); // idempotent no-op
    expect((await getPlayer("A")).balance).toBe(balanceA);
  });

  it("undo reverses reporting bonuses/penalties along with the settlement", async () => {
    await runFullPlay();
    await settlePlayHandler(db, GAME_ID, "0001");

    // §12.9: the monitor claim carries undo authority in crowd games.
    await undoLastSettlementHandler(db, GAME_ID, "0001", "any-monitor-uid", true);

    for (const uid of ["A", "B", "C", "D"]) {
      expect((await getPlayer(uid)).balance).toBe(1000);
    }

    // And the crowd stays out of a human-reversed play (§12.9): no
    // re-finalization even after the vote timeout.
    await handleReport(db, GAME_ID, "0001", SNAP + 120_000);
    expect((await getPlay("0001")).result).toBeUndefined();
  });
});

describe("quorum/margin shortfall → VOID (§12.6)", () => {
  const SNAP = 100_000;

  async function lockPlayWithWagers(): Promise<void> {
    await seedGame();
    for (const uid of ["A", "B", "C", "D"]) await seedPlayer(uid);
    await seedPlay("0001", { state: "locked", snapAt: ts(SNAP) });
    await seedWager("0001", "A", "run", "3", 100, 100, SNAP - 20_000);
    await seedWager("0001", "B", "pass", "<5", 100, 100, SNAP - 20_000);
    await seedWager("0001", "C", "run", "3", 100, 100, SNAP - 20_000);
    await seedWager("0001", "D", "run", "3", 100, 100, SNAP - 20_000);
  }

  it("voids at timeout when too few reporters show up", async () => {
    await lockPlayWithWagers();
    await seedVoteReport("0001", "A", "type", "run", SNAP + 5_000); // 1 reporter < quorum 3

    await handleReport(db, GAME_ID, "0001", SNAP + 21_000);

    const play = await getPlay("0001");
    expect(play.state).toBe("voided");
    expect(play.reportingFlag?.reasons).toContain("voided_type_quorum_or_margin");

    // The void-advance path (trigger in prod) opens the next play.
    await advanceAfterVoidHandler(db, GAME_ID, "0001");
    expect((await getPlay("0002")).state).toBe("open");
  });

  it("voids at timeout when the margin stays under auto-trust (50/50 split)", async () => {
    await lockPlayWithWagers();
    await seedVoteReport("0001", "A", "type", "run", SNAP + 5_000);
    await seedVoteReport("0001", "B", "type", "pass", SNAP + 5_100);
    await seedVoteReport("0001", "C", "type", "run", SNAP + 5_200);
    await seedVoteReport("0001", "D", "type", "pass", SNAP + 5_300);

    await handleReport(db, GAME_ID, "0001", SNAP + 21_000);

    expect((await getPlay("0001")).state).toBe("voided");
  });

  it("waits (does not void) before the timeout even when quorum is short", async () => {
    await lockPlayWithWagers();
    await seedVoteReport("0001", "A", "type", "run", SNAP + 5_000);

    await handleReport(db, GAME_ID, "0001", SNAP + 10_000);

    expect((await getPlay("0001")).state).toBe("locked");
  });

  it("voids with no reports at all at timeout — the sweep's stall case", async () => {
    await lockPlayWithWagers();

    await sweepCrowdGames(db, SNAP + 21_000);

    expect((await getPlay("0001")).state).toBe("voided");
  });
});

describe("fraud-detection flags (§12.6)", () => {
  const SNAP = 100_000;

  it("flags a thin (suspicious-band) margin without blocking settlement", async () => {
    await seedGame();
    for (const uid of ["A", "B", "C"]) await seedPlayer(uid);
    await seedPlay("0001", { state: "locked", snapAt: ts(SNAP) });
    await seedWager("0001", "A", "run", "3", 100, 100, SNAP - 20_000);
    await seedWager("0001", "B", "pass", "<5", 100, 100, SNAP - 20_000);
    await seedWager("0001", "C", "run", "3", 100, 100, SNAP - 20_000);

    // Type: 2/3 run ≈ 0.667 — inside [0.65, 0.75). Result: unanimous "3".
    await seedVoteReport("0001", "A", "type", "run", SNAP + 5_000);
    await seedVoteReport("0001", "B", "type", "pass", SNAP + 5_100);
    await seedVoteReport("0001", "C", "type", "run", SNAP + 5_200);
    await seedVoteReport("0001", "A", "result", "3", SNAP + 8_000);
    await seedVoteReport("0001", "B", "result", "3", SNAP + 8_100);
    await seedVoteReport("0001", "C", "result", "3", SNAP + 8_200);

    await handleReport(db, GAME_ID, "0001", SNAP + 21_000);

    const play = await getPlay("0001");
    expect(play.result).toEqual({ type: "run", bucket: "3" });
    expect(play.reportingFlag?.reasons).toContain("type_margin_thin");
  });

  it("flags stake concentration above the cap fraction", async () => {
    await seedGame({}, { stakeConcentrationCapFraction: 0.25 });
    for (const uid of ["A", "B", "C"]) await seedPlayer(uid);
    await seedPlay("0001", { state: "locked", snapAt: ts(SNAP) });
    // A's winning stake (100) far exceeds 25% of opposing stakes (10).
    await seedWager("0001", "A", "run", "3", 100, 100, SNAP - 20_000);
    await seedWager("0001", "B", "pass", "<5", 10, 10, SNAP - 20_000);
    await seedWager("0001", "C", "run", "3", 10, 10, SNAP - 20_000);

    for (const uid of ["A", "B", "C"]) {
      await seedVoteReport("0001", uid, "type", "run", SNAP + 5_000);
      await seedVoteReport("0001", uid, "result", "3", SNAP + 8_000);
    }

    await handleReport(db, GAME_ID, "0001", SNAP + 21_000);

    const play = await getPlay("0001");
    expect(play.result).toEqual({ type: "run", bucket: "3" });
    expect(play.reportingFlag?.reasons).toContain("type_stake_concentration");
  });
});

describe("monitor void (§12.9)", () => {
  it("voids an open or locked play; rejects non-monitors and settled plays", async () => {
    await seedGame();
    await seedPlay("0001", { state: "locked", snapAt: ts(100_000) });

    await expect(monitorVoidPlayHandler(db, GAME_ID, "0001", false)).rejects.toThrow(/Only monitors/);

    await monitorVoidPlayHandler(db, GAME_ID, "0001", true);
    expect((await getPlay("0001")).state).toBe("voided");

    await expect(monitorVoidPlayHandler(db, GAME_ID, "0001", true)).rejects.toThrow(/open or locked/);
  });
});

describe("scheduleGame (§12.10 / §11.7)", () => {
  it("creates a scheduled game with defaults; kickoff opens it later", async () => {
    const result = await scheduleGameHandler(
      db,
      { gameId: "sunday-broncos", scheduledStartAtMillis: 1_000_000, config: { crowdMode: "live" } },
      "scheduler-1",
      true,
    );
    expect(result.gameId).toBe("sunday-broncos");

    const game = (await db.doc("games/sunday-broncos").get()).data() as Game;
    expect(game.status).toBe("scheduled");
    expect(game.scheduledStartAt?.toMillis()).toBe(1_000_000);
    expect(game.operatorUids).toEqual(["scheduler-1"]);
    expect(game.config.crowdMode).toBe("live");
    expect(game.config.buckets.pass).toContain("scramble");

    // No play exists until the kickoff burst (§12.10).
    expect((await db.doc("games/sunday-broncos/plays/0001").get()).exists).toBe(false);
  });

  it("rejects a non-admin caller", async () => {
    await expect(
      scheduleGameHandler(db, { gameId: "nope", scheduledStartAtMillis: 1 }, "someone", false),
    ).rejects.toThrow(/scheduling admins/);
  });

  it("rejects a duplicate gameId", async () => {
    await scheduleGameHandler(db, { gameId: "dupe", scheduledStartAtMillis: 1 }, "scheduler-1", true);
    await expect(
      scheduleGameHandler(db, { gameId: "dupe", scheduledStartAtMillis: 2 }, "scheduler-1", true),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects a malformed gameId", async () => {
    await expect(
      scheduleGameHandler(db, { gameId: "a b!", scheduledStartAtMillis: 1 }, "scheduler-1", true),
    ).rejects.toThrow(/gameId/);
  });
});
