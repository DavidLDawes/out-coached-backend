// DESIGN.md §12 / PLAN.md CR-2 — the business logic behind the crowd-run
// triggers, separated from index.ts's event glue the same way handlers.ts
// is, so everything here runs directly against the Firestore emulator.
//
// Division of labor: crowd/*.ts decides (pure), this file reads state, calls
// those decisions, and applies transitions. In "shadow" mode every would-be
// transition is recorded to games/{gameId}/shadowDecisions instead of being
// applied — that's PLAN.md CR-5's calibration data.

import { FieldValue, Firestore, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { detectBurst, type SignalLike } from "./crowd/burst";
import { evaluateVote, tallyVote, type ReportLike } from "./crowd/consensus";
import { computeQuorum, evaluateAcceptance } from "./crowd/quorum";
import { resolveCrowdConfig, CROWD_DEFAULTS, type CrowdConfig } from "./crowd/config";
import { selectCountedWagers, type CountedWager } from "./settlement";
import type {
  CrowdReport,
  Game,
  GameConfig,
  MomentSignal,
  MomentType,
  Play,
  PlayType,
  WagerRevision,
} from "./types";

// ---------------------------------------------------------------------------
// Shadow-mode recording
// ---------------------------------------------------------------------------

async function recordShadowDecision(
  firestore: Firestore,
  gameId: string,
  docId: string,
  decision: Record<string, unknown>,
): Promise<void> {
  // Deterministic doc IDs make repeated evaluation of the same would-be
  // decision idempotent — later evaluations just overwrite the same record.
  await firestore.doc(`games/${gameId}/shadowDecisions/${docId}`).set({
    ...decision,
    recordedAt: FieldValue.serverTimestamp(),
  });
}

// ---------------------------------------------------------------------------
// Moment signals (§12.2): kickoff, period markers, commercial mode
// ---------------------------------------------------------------------------

/** Which game state each momentType is valid from — mirrors firestore.rules. */
function momentApplies(game: Game, momentType: MomentType): boolean {
  switch (momentType) {
    case "kickoff":
      return game.status === "scheduled";
    case "end_q1":
      return game.status === "live" && game.period === "Q1";
    case "half":
      return game.status === "live" && game.period === "Q2";
    case "end_q3":
      return game.status === "live" && game.period === "Q3";
    case "start_ot":
    case "end_game":
      return (
        game.status === "live" &&
        (game.period === "Q4" || game.period === "OT") &&
        !game.endGameHoldUntil
      );
    case "commercial_enter":
      return game.status === "live" && game.adMode !== "commercial";
    case "commercial_exit":
      return game.adMode === "commercial";
  }
}

export async function handleMomentSignal(
  firestore: Firestore,
  gameId: string,
  momentType: MomentType,
  nowMillis: number = Date.now(),
): Promise<void> {
  const gameRef = firestore.doc(`games/${gameId}`);
  const game = (await gameRef.get()).data() as Game | undefined;
  if (!game) return;
  const crowd = resolveCrowdConfig(game.config);
  if (crowd.crowdMode === "off") return;
  if (!momentApplies(game, momentType)) return;

  const signalsSnap = await gameRef
    .collection("momentSignals")
    .where("momentType", "==", momentType)
    .orderBy("signaledAt", "desc")
    .limit(50)
    .get();
  let signals: SignalLike[] = signalsSnap.docs.map((doc) => {
    const data = doc.data() as MomentSignal;
    return { uid: data.playerUid, atMillis: data.signaledAt.toMillis() };
  });

  // Commercial signals repeat across the game — only signals since the last
  // adMode flip count toward the next one. One-shot moments are covered by
  // the state gate instead.
  if (momentType === "commercial_enter" || momentType === "commercial_exit") {
    const changedAt = (game as { adModeChangedAt?: Timestamp }).adModeChangedAt;
    if (changedAt) signals = signals.filter((s) => s.atMillis > changedAt.toMillis());
  }

  const burstAt = detectBurst(signals, crowd.snapBurstWindowSeconds * 1000, crowd.momentBurstMinReports);
  if (burstAt === null) return;

  if (crowd.crowdMode === "shadow") {
    await recordShadowDecision(firestore, gameId, `${momentType}_${game.status}_${game.period}`, {
      kind: "moment",
      momentType,
      burstAtMillis: burstAt,
      status: game.status,
      period: game.period,
    });
    return;
  }

  // Live: apply inside a transaction, re-checking the state gate so two
  // concurrent trigger invocations can't double-apply.
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    const current = snap.data() as Game | undefined;
    if (!current || !momentApplies(current, momentType)) return;

    switch (momentType) {
      case "kickoff": {
        tx.update(gameRef, { status: "live" });
        const firstPlayRef = gameRef.collection("plays").doc(current.currentPlayId);
        tx.set(
          firstPlayRef,
          { state: "open", openedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        break;
      }
      case "end_q1":
        tx.update(gameRef, { period: "Q2" });
        break;
      case "half":
        tx.update(gameRef, { status: "halftime", period: "Q3" });
        break;
      case "end_q3":
        tx.update(gameRef, { period: "Q4" });
        break;
      case "start_ot":
      case "end_game":
        // §12.9 — irreversible markers enter a grace/hold period instead of
        // applying immediately; the sweep makes them permanent, the monitor
        // can cancel.
        tx.update(gameRef, {
          endGameHoldUntil: Timestamp.fromMillis(nowMillis + crowd.endGameGraceSeconds * 1000),
          endGameHoldType: momentType,
        });
        break;
      case "commercial_enter":
        // nowMillis (not serverTimestamp) so the stale-signal filter above
        // compares like-for-like against signaledAt millis.
        tx.update(gameRef, { adMode: "commercial", adModeChangedAt: Timestamp.fromMillis(nowMillis) });
        break;
      case "commercial_exit":
        tx.update(gameRef, { adMode: "game", adModeChangedAt: Timestamp.fromMillis(nowMillis) });
        break;
    }
  });
  logger.info("handleMomentSignal: applied", { gameId, momentType, burstAt });
}

// ---------------------------------------------------------------------------
// Per-play reports (§12.2 snap, §12.3 type/result votes)
// ---------------------------------------------------------------------------

interface EligibleWagers {
  counted: Map<string, CountedWager>;
  cutoffMillis: number;
}

async function loadCountedWagers(
  firestore: Firestore,
  gameId: string,
  playId: string,
  snapAtMillis: number,
  config: GameConfig,
): Promise<EligibleWagers> {
  const cutoffMillis = snapAtMillis - config.lockWindowSeconds * 1000;
  const wagersSnap = await firestore.collection(`games/${gameId}/plays/${playId}/wagers`).get();
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
  return { counted: selectCountedWagers(revisions, cutoffMillis), cutoffMillis };
}

function reportsFor(
  reports: CrowdReport[],
  phase: "type" | "result",
  eligibleUids: Set<string>,
  validValues: Set<string>,
): ReportLike[] {
  return reports
    .filter((r) => r.phase === phase && eligibleUids.has(r.playerUid) && validValues.has(r.value))
    .map((r) => ({ uid: r.playerUid, value: r.value, atMillis: r.reportedAt.toMillis() }));
}

/** Firestore rejects undefined values — build the flag with only present shares. */
function buildFlag(
  reasons: string[],
  typeShare: number | undefined,
  resultShare: number | undefined,
): Record<string, unknown> {
  const flag: Record<string, unknown> = { reasons };
  if (typeShare !== undefined) flag.typeShare = typeShare;
  if (resultShare !== undefined) flag.resultShare = resultShare;
  return flag;
}

type VoteOutcome =
  | { kind: "wait" }
  | { kind: "void"; reason: string }
  | { kind: "official"; value: string; share: number; total: number; suspicious: boolean };

function evaluatePoolVote(
  reports: ReportLike[],
  eligibleCount: number,
  snapAtMillis: number,
  timeoutSeconds: number,
  crowd: CrowdConfig,
  nowMillis: number,
): VoteOutcome {
  const timeoutAtMillis = snapAtMillis + timeoutSeconds * 1000;
  const tally = tallyVote(reports);
  const decision = evaluateVote(tally, {
    nowMillis,
    timeoutAtMillis,
    stableShare: crowd.typeVoteStableShare,
    stabilityMillis: crowd.voteStabilitySeconds * 1000,
  });
  if (decision.kind === "wait") return { kind: "wait" };
  if (decision.kind === "no-reports") return { kind: "void", reason: "no_reports" };

  const quorum = computeQuorum(eligibleCount, crowd);
  const verdict = evaluateAcceptance(decision.total, decision.share, quorum, crowd);
  if (verdict.kind === "reject") {
    // A stable-but-unacceptable vote may still grow before the timeout;
    // only reject for good once time is up (§12.6).
    if (nowMillis < timeoutAtMillis) return { kind: "wait" };
    return { kind: "void", reason: "quorum_or_margin" };
  }
  return {
    kind: "official",
    value: decision.value,
    share: decision.share,
    total: decision.total,
    suspicious: verdict.suspicious,
  };
}

/** §12.6 stake-concentration flag: any winning wager above the cap fraction of opposing stakes. */
function stakeConcentrationFlag(
  counted: Map<string, CountedWager>,
  officialValue: string,
  pool: "type" | "result",
  capFraction: number,
): boolean {
  let opposing = 0;
  let maxWinning = 0;
  for (const wager of counted.values()) {
    const stake = pool === "type" ? wager.typeStake : wager.resultStake;
    if (stake <= 0) continue;
    const pick = pool === "type" ? wager.typePick : wager.bucketPick;
    if (pick === officialValue) {
      maxWinning = Math.max(maxWinning, stake);
    } else {
      opposing += stake;
    }
  }
  return opposing > 0 && maxWinning > capFraction * opposing;
}

/**
 * Evaluates the current play's crowd state: snap burst while OPEN, then the
 * type vote, then the result vote (sequential — result values are only
 * meaningful within the finalized type's bucket list). Safe to call
 * repeatedly: from the report-write trigger and from the sweep.
 */
export async function handleReport(
  firestore: Firestore,
  gameId: string,
  playId: string,
  nowMillis: number = Date.now(),
): Promise<void> {
  const gameRef = firestore.doc(`games/${gameId}`);
  const game = (await gameRef.get()).data() as Game | undefined;
  if (!game) return;
  const crowd = resolveCrowdConfig(game.config);
  if (crowd.crowdMode === "off") return;

  const playRef = gameRef.collection("plays").doc(playId);
  const play = (await playRef.get()).data() as Play | undefined;
  if (!play) return;

  const reportsSnap = await playRef.collection("reports").get();
  const reports = reportsSnap.docs.map((d) => d.data() as CrowdReport);

  // --- Snap burst (§12.2) -------------------------------------------------
  if (play.state === "open") {
    const snapSignals: SignalLike[] = reports
      .filter((r) => r.phase === "snap")
      .map((r) => ({ uid: r.playerUid, atMillis: r.reportedAt.toMillis() }));
    const burstAt = detectBurst(snapSignals, crowd.snapBurstWindowSeconds * 1000, crowd.snapBurstMinReports);
    if (burstAt === null) return;

    if (crowd.crowdMode === "shadow") {
      await recordShadowDecision(firestore, gameId, `snap_${playId}`, {
        kind: "snap",
        playId,
        burstAtMillis: burstAt,
      });
      return;
    }

    await firestore.runTransaction(async (tx) => {
      // All reads before any writes — Firestore transaction requirement.
      const [playSnap, gameSnap] = await Promise.all([tx.get(playRef), tx.get(gameRef)]);
      const current = playSnap.data() as Play | undefined;
      if (!current || current.state !== "open") return;
      tx.update(playRef, { state: "locked", snapAt: Timestamp.fromMillis(burstAt) });
      // A snap during halftime means the second half is underway.
      if ((gameSnap.data() as Game | undefined)?.status === "halftime") {
        tx.update(gameRef, { status: "live" });
      }
    });
    logger.info("handleReport: snap burst locked play", { gameId, playId, burstAt });
    return;
  }

  // --- Type/result votes (§12.3) -------------------------------------------
  if (play.state !== "locked" || play.result || !play.snapAt) return;
  // A human reversed this play (undo) — the crowd stays out of re-entry.
  if (play.settlement?.reversedBy) return;

  const snapAtMillis = play.snapAt.toMillis();
  const { counted } = await loadCountedWagers(firestore, gameId, playId, snapAtMillis, game.config);

  const flagReasons: string[] = [...(play.reportingFlag?.reasons ?? [])];
  const updates: Record<string, unknown> = {};
  let typeOfficial = play.typeOfficial;
  let typeShare = play.reportingFlag?.typeShare;

  if (!typeOfficial) {
    const eligible = new Set([...counted.values()].filter((w) => w.typeStake > 0).map((w) => w.playerUid));
    const outcome = evaluatePoolVote(
      reportsFor(reports, "type", eligible, new Set(["run", "pass"])),
      eligible.size,
      snapAtMillis,
      crowd.typeVoteTimeoutSeconds,
      crowd,
      nowMillis,
    );
    if (outcome.kind === "void") {
      await applyVoteVoid(firestore, gameId, playId, crowd, `type_${outcome.reason}`);
      return;
    }
    if (outcome.kind === "wait") return;

    typeOfficial = outcome.value as PlayType;
    typeShare = outcome.share;
    updates.typeOfficial = typeOfficial;
    if (outcome.suspicious) flagReasons.push("type_margin_thin");
    if (stakeConcentrationFlag(counted, typeOfficial, "type", crowd.stakeConcentrationCapFraction)) {
      flagReasons.push("type_stake_concentration");
    }
  }

  let resultOfficial = play.resultOfficial;
  let resultShare = play.reportingFlag?.resultShare;
  if (!resultOfficial) {
    const eligible = new Set(
      [...counted.values()].filter((w) => w.resultStake > 0).map((w) => w.playerUid),
    );
    const validBuckets = new Set(game.config.buckets[typeOfficial]);
    const outcome = evaluatePoolVote(
      reportsFor(reports, "result", eligible, validBuckets),
      eligible.size,
      snapAtMillis,
      crowd.resultVoteTimeoutSeconds,
      crowd,
      nowMillis,
    );
    if (outcome.kind === "void") {
      await applyVoteVoid(firestore, gameId, playId, crowd, `result_${outcome.reason}`);
      return;
    }
    if (outcome.kind === "wait") {
      // Persist a finalized type so later evaluations (and clients) see it.
      if (updates.typeOfficial && crowd.crowdMode === "live") {
        if (flagReasons.length > 0) {
          updates.reportingFlag = buildFlag(flagReasons, typeShare, undefined);
        }
        await playRef.update(updates);
      }
      return;
    }

    resultOfficial = outcome.value;
    resultShare = outcome.share;
    updates.resultOfficial = resultOfficial;
    if (outcome.suspicious) flagReasons.push("result_margin_thin");
    if (stakeConcentrationFlag(counted, resultOfficial, "result", crowd.stakeConcentrationCapFraction)) {
      flagReasons.push("result_stake_concentration");
    }
  }

  if (crowd.crowdMode === "shadow") {
    await recordShadowDecision(firestore, gameId, `vote_${playId}`, {
      kind: "vote",
      playId,
      typeOfficial,
      resultOfficial,
      typeShare: typeShare ?? null,
      resultShare: resultShare ?? null,
      flagReasons,
    });
    return;
  }

  // Both officials known — write them plus `result`, which hands the play to
  // the existing settlement path (§12.3: the crowd only replaces who supplies
  // the result, never who computes the money).
  if (flagReasons.length > 0) {
    updates.reportingFlag = buildFlag(flagReasons, typeShare, resultShare);
  }
  updates.result = { type: typeOfficial, bucket: resultOfficial };
  await playRef.update(updates);
  logger.info("handleReport: crowd result finalized", { gameId, playId, typeOfficial, resultOfficial });
}

async function applyVoteVoid(
  firestore: Firestore,
  gameId: string,
  playId: string,
  crowd: CrowdConfig,
  reason: string,
): Promise<void> {
  if (crowd.crowdMode === "shadow") {
    await recordShadowDecision(firestore, gameId, `void_${playId}`, { kind: "void", playId, reason });
    return;
  }
  const playRef = firestore.doc(`games/${gameId}/plays/${playId}`);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(playRef);
    const current = snap.data() as Play | undefined;
    if (!current || current.state !== "locked" || current.result) return;
    tx.update(playRef, {
      state: "voided",
      reportingFlag: { reasons: [`voided_${reason}`] },
    });
  });
  logger.info("handleReport: play voided on quorum/margin shortfall", { gameId, playId, reason });
}

// ---------------------------------------------------------------------------
// Sweep (§12.3 timeouts, §12.9 hold expiry) — Cloud Scheduler safety net
// ---------------------------------------------------------------------------

export async function sweepCrowdGames(firestore: Firestore, nowMillis: number = Date.now()): Promise<void> {
  const gamesSnap = await firestore
    .collection("games")
    .where("config.crowdMode", "in", ["shadow", "live"])
    .get();

  for (const gameDoc of gamesSnap.docs) {
    const game = gameDoc.data() as Game;
    const gameId = gameDoc.id;
    if (game.status === "final") continue;

    // §12.9 — expire grace-period holds into permanence (fail-safe: the
    // crowd's call stands unless the monitor cancelled in time).
    if (game.endGameHoldUntil && nowMillis >= game.endGameHoldUntil.toMillis()) {
      const transition =
        game.endGameHoldType === "start_ot"
          ? { period: "OT" }
          : { status: "final" as const };
      await gameDoc.ref.update({
        ...transition,
        endGameHoldUntil: FieldValue.delete(),
        endGameHoldType: FieldValue.delete(),
      });
      logger.info("sweepCrowdGames: hold expired, transition applied", {
        gameId,
        holdType: game.endGameHoldType,
      });
      continue;
    }

    // §12.3 — a stalled vote can't finalize itself from the per-write
    // trigger alone; re-evaluate the current play with the clock moved on.
    if (game.status === "live" || game.status === "halftime") {
      await handleReport(firestore, gameId, game.currentPlayId, nowMillis);
    }
  }
}

// ---------------------------------------------------------------------------
// Monitor actions (§12.9) and scheduling (§12.10)
// ---------------------------------------------------------------------------

export async function cancelHoldHandler(
  firestore: Firestore,
  gameId: string,
  isMonitor: boolean,
): Promise<void> {
  if (!isMonitor) {
    throw new HttpsError("permission-denied", "Only monitors may cancel a hold.");
  }
  const gameRef = firestore.doc(`games/${gameId}`);
  const game = (await gameRef.get()).data() as Game | undefined;
  if (!game?.endGameHoldUntil) {
    throw new HttpsError("failed-precondition", "No pending hold on this game.");
  }
  await gameRef.update({
    endGameHoldUntil: FieldValue.delete(),
    endGameHoldType: FieldValue.delete(),
  });
  logger.info("cancelHoldHandler: hold cancelled", { gameId, holdType: game.endGameHoldType });
}

export async function monitorVoidPlayHandler(
  firestore: Firestore,
  gameId: string,
  playId: string,
  isMonitor: boolean,
): Promise<void> {
  if (!isMonitor) {
    throw new HttpsError("permission-denied", "Only monitors may void a play.");
  }
  const playRef = firestore.doc(`games/${gameId}/plays/${playId}`);
  const play = (await playRef.get()).data() as Play | undefined;
  if (!play || (play.state !== "open" && play.state !== "locked")) {
    throw new HttpsError("failed-precondition", "Only an open or locked play can be voided.");
  }
  await playRef.update({ state: "voided" });
  logger.info("monitorVoidPlayHandler: voided", { gameId, playId });
}

export interface ScheduleGameArgs {
  gameId: string;
  scheduledStartAtMillis: number;
  operatorUids?: string[];
  config?: Partial<GameConfig>;
}

/**
 * §12.10 / §11.7 — the scheduling admin's one job. Creates the game document
 * with status "scheduled"; the first play is opened by the kickoff burst,
 * not here. Gated on the operator custom claim (the existing admin-ish
 * claim), not `monitor` — scheduling is per-game authority, monitoring is
 * cross-game (§12.5).
 */
export async function scheduleGameHandler(
  firestore: Firestore,
  args: ScheduleGameArgs,
  callerUid: string,
  isOperatorClaim: boolean,
): Promise<{ gameId: string }> {
  if (!isOperatorClaim) {
    throw new HttpsError("permission-denied", "Only scheduling admins may create games.");
  }
  if (!args.gameId || !/^[a-zA-Z0-9_-]{3,40}$/.test(args.gameId)) {
    throw new HttpsError("invalid-argument", "gameId must be 3-40 chars of [a-zA-Z0-9_-].");
  }
  if (!Number.isFinite(args.scheduledStartAtMillis)) {
    throw new HttpsError("invalid-argument", "scheduledStartAtMillis is required.");
  }

  const gameRef = firestore.doc(`games/${args.gameId}`);
  const created = await firestore.runTransaction(async (tx) => {
    const existing = await tx.get(gameRef);
    if (existing.exists) return false;

    const config: GameConfig = {
      lockWindowSeconds: 10,
      grubstake: 1000,
      minStake: 1,
      buckets: {
        run: ["loss", "0", "1", "2", "3", "4", "5+"],
        pass: [
          "incomplete",
          "intercepted",
          "sack",
          "scramble",
          "<5",
          "5-7",
          "8-10",
          "11-15",
          "16-20",
          "21+",
        ],
      },
      bustedTopUp: true,
      crowdMode: CROWD_DEFAULTS.crowdMode,
      ...args.config,
    };

    const game: Game = {
      status: "scheduled",
      config,
      currentPlayId: "0001",
      period: "Q1",
      operatorUids: args.operatorUids?.length ? args.operatorUids : [callerUid],
      scheduledStartAt: Timestamp.fromMillis(args.scheduledStartAtMillis),
    };
    tx.set(gameRef, game);
    return true;
  });

  if (!created) {
    throw new HttpsError("already-exists", `Game ${args.gameId} already exists.`);
  }
  logger.info("scheduleGameHandler: game scheduled", {
    gameId: args.gameId,
    scheduledStartAtMillis: args.scheduledStartAtMillis,
    by: callerUid,
  });
  return { gameId: args.gameId };
}
