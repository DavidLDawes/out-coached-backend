// Mirrors DESIGN.md §6. This is the schema source of truth on the backend
// side; the Android app keeps an equivalent set of Kotlin data classes.
// Change both together, and update DESIGN.md §6 alongside.

import type { Timestamp } from "firebase-admin/firestore";

export type GameStatus = "scheduled" | "live" | "halftime" | "final";

export interface BucketConfig {
  run: string[];
  pass: string[];
}

/**
 * DESIGN.md §12 rollout gate. "off" = operator-driven (today's behavior),
 * "shadow" = crowd signals recorded and evaluated but never applied,
 * "live" = crowd signals drive the game.
 */
export type CrowdMode = "off" | "shadow" | "live";

/**
 * DESIGN.md §12.5 crowd tunables. All optional on the stored document so
 * pre-crowd games keep working; resolve through crowd/config.ts's
 * `resolveCrowdConfig` before use — never read these fields directly.
 */
export interface CrowdConfigFields {
  crowdMode?: CrowdMode;
  snapBurstWindowSeconds?: number;
  snapBurstMinReports?: number;
  momentBurstMinReports?: number;
  endGameGraceSeconds?: number;
  joinWindowSeconds?: number;
  typeVoteStableShare?: number;
  voteStabilitySeconds?: number;
  typeVoteTimeoutSeconds?: number;
  resultVoteTimeoutSeconds?: number;
  reportQuorumMin?: number;
  reportQuorumShare?: number;
  reportMarginAutoTrust?: number;
  reportMarginSuspicious?: number;
  reportingBonusCredits?: number;
  passBucketAdjacency?: string[][];
  passCategoricalBuckets?: string[];
  stakeConcentrationCapFraction?: number;
}

export interface GameConfig extends CrowdConfigFields {
  lockWindowSeconds: number;
  grubstake: number;
  minStake: number;
  buckets: BucketConfig;
  bustedTopUp: boolean;
}

export type AdMode = "game" | "commercial";

export interface Game {
  status: GameStatus;
  config: GameConfig;
  currentPlayId: string;
  period: string;
  operatorUids: string[];
  scheduledStartAt?: Timestamp; // §12.10 — set by scheduleGame
  adMode?: AdMode; // §12.8 — crowd-driven Commercial/Game toggle
  endGameHoldUntil?: Timestamp; // §12.9 — grace period for irreversible markers
  endGameHoldType?: "end_game" | "start_ot";
}

/**
 * DESIGN.md §12.2. Game-level moment signals; `snap` is per-play and lives
 * in plays/{playId}/reports instead (phase: "snap").
 */
export type MomentType =
  | "kickoff"
  | "end_q1"
  | "half"
  | "end_q3"
  | "start_ot"
  | "end_game"
  | "commercial_enter"
  | "commercial_exit";

export interface MomentSignal {
  playerUid: string;
  momentType: MomentType;
  signaledAt: Timestamp;
}

export type ReportPhase = "snap" | "type" | "result";

/** DESIGN.md §12.3/§12.5 — append-only per-play crowd reports. */
export interface CrowdReport {
  playerUid: string;
  phase: ReportPhase;
  value: string; // ignored for phase "snap"
  reportedAt: Timestamp;
}

/** §12.6 non-blocking fraud detection — written onto the play doc. */
export interface ReportingFlag {
  reasons: string[];
  typeShare?: number;
  resultShare?: number;
}

export type PlayState = "open" | "locked" | "settling" | "settled" | "voided";
export type PlayType = "run" | "pass";

export interface PlayResult {
  type: PlayType;
  bucket: string;
}

export interface PlaySettlement {
  typePool: number;
  resultPool: number;
  typeWinners: number;
  resultWinners: number;
  settledAt: Timestamp;
  reversedBy?: string;
}

export interface Play {
  state: PlayState;
  openedAt: Timestamp;
  snapAt?: Timestamp;
  cutoffAt?: Timestamp;
  result?: PlayResult;
  settlement?: PlaySettlement;
  // §12.3 — crowd-finalized official values. When both are present (live
  // crowd mode), the crowd handler writes `result` from them and the
  // existing settlement path takes over unchanged.
  typeOfficial?: PlayType;
  resultOfficial?: string;
  reportingFlag?: ReportingFlag; // §12.6 audit trail
}

export interface WagerRevision {
  playerUid: string;
  typePick: PlayType;
  bucketPick: string;
  typeStake: number;
  resultStake: number;
  placedAt: Timestamp;
}

export interface PlayerStats {
  typeBets: number;
  typeCorrect: number;
  typeWrong: number;
  resultCorrect: number;
}

export interface Player {
  displayName: string;
  balance: number;
  stats: PlayerStats;
}

export type LedgerReason =
  | "settlement"
  | "refund"
  | "undo"
  | "topup"
  | "reporting_bonus" // §12.4 — agreed with the official crowd outcome
  | "reporting_penalty"; // §12.4 — self-serving disagreement

export interface LedgerEntry {
  delta: number;
  balanceAfter: number;
  reason: LedgerReason;
  playerUid: string;
  playId: string;
  createdAt: Timestamp;
}

export interface LeaderboardBalanceEntry {
  uid: string;
  name: string;
  balance: number;
}

export interface LeaderboardAccuracyEntry {
  uid: string;
  name: string;
  wrong: number;
}

export interface LeaderboardAccuracy {
  mode: "perfect-count" | "top5";
  perfectCount?: number;
  entries?: LeaderboardAccuracyEntry[];
  tieNote?: string;
}

export interface Leaderboard {
  topBalance: LeaderboardBalanceEntry[];
  accuracy: LeaderboardAccuracy;
  updatedAt: Timestamp;
}
