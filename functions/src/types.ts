// Mirrors DESIGN.md §6. This is the schema source of truth on the backend
// side; the Android app keeps an equivalent set of Kotlin data classes.
// Change both together, and update DESIGN.md §6 alongside.

import type { Timestamp } from "firebase-admin/firestore";

export type GameStatus = "scheduled" | "live" | "halftime" | "final";

export interface BucketConfig {
  run: string[];
  pass: string[];
}

export interface GameConfig {
  lockWindowSeconds: number;
  grubstake: number;
  minStake: number;
  buckets: BucketConfig;
  bustedTopUp: boolean;
}

export interface Game {
  status: GameStatus;
  config: GameConfig;
  currentPlayId: string;
  period: string;
  operatorUids: string[];
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

export type LedgerReason = "settlement" | "refund" | "undo" | "topup";

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
