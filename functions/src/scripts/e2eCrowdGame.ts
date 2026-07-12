// End-to-end crowd-run game against the FULL emulator stack — PLAN.md CR-3's
// exit criterion, one level above the vitest emulator suite: that suite calls
// the handlers directly; this drives everything through client-style
// Firestore writes and lets the *deployed triggers* (onMomentSignalCreated,
// onReportCreated, settlePlay, advanceAfterVoid) fire inside the Functions
// emulator, exercising the real trigger graph.
//
// Usage (two terminals, from this package):
//   npm run build
//   firebase emulators:start --only functions,firestore,auth --project demo-out-coached-e2e
// then:
//   FIRESTORE_EMULATOR_HOST=localhost:8080 GCLOUD_PROJECT=demo-out-coached-e2e npm run e2e
//
// The one thing not trigger-driven here: Cloud Scheduler doesn't run inside
// the emulator, so the §12.9 hold-expiry sweep is invoked directly at the
// end — exactly the call Cloud Scheduler makes in prod, on its 1-minute tick.

import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { sweepCrowdGames } from "../crowdHandlers";
import type { Game, LedgerEntry, Play } from "../types";

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "demo-out-coached-e2e";
const GAME_ID = "e2e-crowd-game";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("FIRESTORE_EMULATOR_HOST is not set — refusing to run against a real project.");
  process.exit(1);
}

initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();

const gameRef = db.doc(`games/${GAME_ID}`);
let passed = 0;

function ok(label: string) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

function fail(label: string, detail: string): never {
  console.error(`  ✗ ${label} — ${detail}`);
  process.exit(1);
}

/** Polls until `check` returns a truthy description or the timeout passes. */
async function waitFor(label: string, timeoutMillis: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMillis;
  while (Date.now() < deadline) {
    if (await check()) {
      ok(label);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(label, `not reached within ${timeoutMillis}ms`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getGame(): Promise<Game | undefined> {
  return (await gameRef.get()).data() as Game | undefined;
}

async function getPlay(playId: string): Promise<Play | undefined> {
  return (await gameRef.collection("plays").doc(playId).get()).data() as Play | undefined;
}

async function sendMomentSignal(uid: string, momentType: string): Promise<void> {
  await gameRef.collection("momentSignals").add({
    playerUid: uid,
    momentType,
    signaledAt: FieldValue.serverTimestamp(),
  });
}

async function sendReport(playId: string, uid: string, phase: string, value: string): Promise<void> {
  await gameRef.collection("plays").doc(playId).collection("reports").add({
    playerUid: uid,
    phase,
    value,
    reportedAt: FieldValue.serverTimestamp(),
  });
}

async function main() {
  console.log(`\nCrowd-run e2e against ${process.env.FIRESTORE_EMULATOR_HOST} (${PROJECT_ID})\n`);

  // --- Setup: a scheduled crowd game with e2e-sized tunables --------------
  // lockWindow 1s so wagers placed a couple of seconds pre-snap count;
  // voteStability 0 so unanimous votes finalize on the report trigger
  // itself rather than needing a later nudge; grace 3s so hold expiry is
  // testable in-run.
  await gameRef.set({
    status: "scheduled",
    config: {
      lockWindowSeconds: 1,
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
      endGameGraceSeconds: 3,
      typeVoteStableShare: 0.8,
      voteStabilitySeconds: 0,
      typeVoteTimeoutSeconds: 20,
      resultVoteTimeoutSeconds: 40,
      reportQuorumMin: 3,
      reportQuorumShare: 0.6,
      reportMarginAutoTrust: 0.65,
      reportMarginSuspicious: 0.75,
      reportingBonusCredits: 3,
      stakeConcentrationCapFraction: 100,
    },
    currentPlayId: "0001",
    period: "Q1",
    operatorUids: ["e2e-scheduler"],
    scheduledStartAt: FieldValue.serverTimestamp(),
  });
  for (const uid of ["A", "B", "C", "D"]) {
    await gameRef.collection("players").doc(uid).set({
      displayName: uid,
      balance: 1000,
      stats: { typeBets: 0, typeCorrect: 0, typeWrong: 0, resultCorrect: 0 },
    });
  }
  ok("scheduled game + 4 players seeded");

  // --- §12.2 kickoff burst → onMomentSignalCreated trigger ----------------
  console.log("\nKickoff:");
  await sendMomentSignal("A", "kickoff");
  await sendMomentSignal("B", "kickoff");
  await waitFor("kickoff burst flips scheduled → live (trigger-driven)", 15_000, async () => {
    return (await getGame())?.status === "live";
  });
  await waitFor("first play opened by the kickoff trigger", 15_000, async () => {
    return (await getPlay("0001"))?.state === "open";
  });

  // --- Wagers, then a §12.2 snap burst → onReportCreated trigger ----------
  console.log("\nPlay 0001 — wagers and snap:");
  for (const uid of ["A", "B", "C", "D"]) {
    await gameRef.collection("plays").doc("0001").collection("wagers").add({
      playerUid: uid,
      typePick: uid === "B" ? "pass" : "run",
      bucketPick: uid === "B" ? "<5" : "3",
      typeStake: 100,
      resultStake: 100,
      placedAt: FieldValue.serverTimestamp(),
    });
  }
  ok("wagers placed (A/C/D run·3, B pass·<5)");
  await sleep(2_500); // past the 1s lock window, so all wagers count

  await sendReport("0001", "A", "snap", "");
  await sendReport("0001", "B", "snap", "");
  await sendReport("0001", "C", "snap", "");
  await waitFor("snap burst locks the play (trigger-driven)", 15_000, async () => {
    const play = await getPlay("0001");
    return play?.state === "locked" && play.snapAt != null;
  });

  // --- §12.3 votes → result → settlePlay trigger → §12.4 ledger -----------
  console.log("\nPlay 0001 — crowd votes and settlement:");
  for (const uid of ["A", "B", "C", "D"]) {
    await sendReport("0001", uid, "type", "run");
  }
  for (const uid of ["A", "B", "C", "D"]) {
    await sendReport("0001", uid, "result", "3");
  }
  await waitFor("votes finalize into an official result (trigger-driven)", 15_000, async () => {
    const play = await getPlay("0001");
    return play?.result?.type === "run" && play.result.bucket === "3";
  });
  await waitFor("settlePlay trigger settles the play", 15_000, async () => {
    return (await getPlay("0001"))?.state === "settled";
  });
  await waitFor("next play opened by settlement", 15_000, async () => {
    return (await getPlay("0002"))?.state === "open";
  });

  // Parimutuel: pool 400/pool, winners A/C/D stakes 300 → 133 each per pool.
  // §12.4 on top: everyone reported run·3 (all agree) → +3 type +3 result.
  // B: wagered pass·<5 (lost both stakes) but reported honestly → bonuses.
  const expect = { A: 1000 - 200 + 266 + 6, B: 1000 - 200 + 6, C: 1000 - 200 + 266 + 6, D: 1000 - 200 + 266 + 6 };
  for (const [uid, expected] of Object.entries(expect)) {
    const balance = (await gameRef.collection("players").doc(uid).get()).data()?.balance;
    if (balance !== expected) fail(`balance ${uid}`, `expected ${expected}, got ${balance}`);
  }
  ok("balances match parimutuel + reporting bonuses (A/C/D 1072, B 806)");

  const ledger = await gameRef.collection("ledger").where("playId", "==", "0001").get();
  const reasons = ledger.docs.map((d) => (d.data() as LedgerEntry).reason);
  const count = (r: string) => reasons.filter((x) => x === r).length;
  if (count("settlement") !== 4 || count("reporting_bonus") !== 8) {
    fail("ledger entries", `expected 4 settlement + 8 reporting_bonus, got ${JSON.stringify(reasons)}`);
  }
  ok("ledger holds 4 settlement + 8 reporting_bonus entries");

  // --- §12.8 commercial mode round-trip ------------------------------------
  console.log("\nCommercial mode:");
  await sendMomentSignal("A", "commercial_enter");
  await sendMomentSignal("B", "commercial_enter");
  await waitFor("commercial_enter burst flips adMode (trigger-driven)", 15_000, async () => {
    return (await getGame())?.adMode === "commercial";
  });
  await sendMomentSignal("C", "commercial_exit");
  await sendMomentSignal("D", "commercial_exit");
  await waitFor("commercial_exit burst flips it back", 15_000, async () => {
    return (await getGame())?.adMode === "game";
  });

  // --- §12.9 end_game hold → grace expiry via the sweep --------------------
  console.log("\nEnd of game:");
  await gameRef.update({ period: "Q4" }); // fast-forward the periods for the e2e
  await sendMomentSignal("A", "end_game");
  await sendMomentSignal("B", "end_game");
  await waitFor("end_game burst enters a grace hold, not final (trigger-driven)", 15_000, async () => {
    const game = await getGame();
    return game?.endGameHoldType === "end_game" && game.status === "live";
  });

  await sleep(3_500); // let the 3s grace period lapse
  // Cloud Scheduler's 1-minute tick in prod; invoked directly here since the
  // emulator has no scheduler.
  await sweepCrowdGames(db);
  await waitFor("expired hold finalizes the game (sweep)", 15_000, async () => {
    return (await getGame())?.status === "final";
  });

  console.log(`\nPASS — ${passed} checks, zero operator writes anywhere.\n`);
  process.exit(0);
}

main().catch((error) => {
  console.error("\ne2e failed:", error);
  process.exit(1);
});
