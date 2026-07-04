// Pure parimutuel settlement math — DESIGN.md §4. No Firebase imports here on
// purpose: this file is unit-tested directly against the worked examples in
// §4.3 without needing the emulator. index.ts wires this up to real
// Firestore reads/writes.

import type { PlayType } from "./types";

export interface WagerLike {
  playerUid: string;
  typePick: PlayType;
  bucketPick: string;
  typeStake: number;
  resultStake: number;
  placedAtMillis: number;
}

export interface CountedWager {
  playerUid: string;
  typePick: PlayType;
  bucketPick: string;
  typeStake: number;
  resultStake: number;
}

/**
 * DESIGN.md §2.1: the wager that counts for each player is the latest
 * revision with timestamp <= cutoffAt. A later revision doesn't void the
 * pick — it just doesn't apply, and the previous in-time revision stands.
 * If a player's first-ever revision is after the cutoff, they have no
 * counted wager at all (absent from the returned map).
 */
export function selectCountedWagers(
  revisions: WagerLike[],
  cutoffMillis: number,
): Map<string, CountedWager> {
  const sorted = [...revisions].sort((a, b) => a.placedAtMillis - b.placedAtMillis);
  const counted = new Map<string, CountedWager>();
  for (const rev of sorted) {
    if (rev.placedAtMillis <= cutoffMillis) {
      counted.set(rev.playerUid, {
        playerUid: rev.playerUid,
        typePick: rev.typePick,
        bucketPick: rev.bucketPick,
        typeStake: rev.typeStake,
        resultStake: rev.resultStake,
      });
    }
  }
  return counted;
}

/**
 * DESIGN.md §4.4: stake <= balance is enforced at settlement, clamping to
 * balance if it's somehow short (rare — per-play sequencing means nothing
 * else can move this player's balance between wager placement and this
 * play's settlement). Scales both pool stakes down proportionally rather
 * than favoring one pool over the other.
 */
export function clampStakeToBalance(wager: CountedWager, balance: number): CountedWager {
  const total = wager.typeStake + wager.resultStake;
  if (total <= balance) return wager;
  if (balance <= 0) return { ...wager, typeStake: 0, resultStake: 0 };
  const newTypeStake = Math.floor((wager.typeStake * balance) / total);
  return { ...wager, typeStake: newTypeStake, resultStake: balance - newTypeStake };
}

export interface PoolOutcome {
  pool: number;
  winningStakes: number;
  winnerCount: number;
  payouts: Map<string, number>;
}

/**
 * DESIGN.md §4.3: payout_i = floor(pool * stake_i / winningStakes), applied
 * independently per pool. No winners -> push (every stake refunded).
 * Everyone wins -> formula degenerates to stakes returned; no special case.
 * Integer floor breakage is burned, never overpaid.
 */
export function settlePool(
  wagers: Map<string, CountedWager>,
  stakeOf: (w: CountedWager) => number,
  isWinner: (w: CountedWager) => boolean,
): PoolOutcome {
  let pool = 0;
  let winningStakes = 0;
  let winnerCount = 0;
  const stakes = new Map<string, number>();

  for (const wager of wagers.values()) {
    const stake = stakeOf(wager);
    if (stake <= 0) continue;
    stakes.set(wager.playerUid, stake);
    pool += stake;
    if (isWinner(wager)) {
      winningStakes += stake;
      winnerCount += 1;
    }
  }

  const payouts = new Map<string, number>();
  if (pool === 0) {
    return { pool, winningStakes, winnerCount, payouts };
  }
  if (winningStakes === 0) {
    for (const [uid, stake] of stakes) payouts.set(uid, stake);
    return { pool, winningStakes, winnerCount, payouts };
  }
  for (const [uid, stake] of stakes) {
    const wager = wagers.get(uid)!;
    payouts.set(uid, isWinner(wager) ? Math.floor((pool * stake) / winningStakes) : 0);
  }
  return { pool, winningStakes, winnerCount, payouts };
}

export interface PlayerSettlement {
  playerUid: string;
  typeStake: number;
  resultStake: number;
  typePayout: number;
  resultPayout: number;
  delta: number;
  typeCorrect: boolean;
  resultCorrect: boolean;
}

export interface SettlementSummary {
  typePool: number;
  resultPool: number;
  typeWinners: number;
  resultWinners: number;
  players: PlayerSettlement[];
}

/**
 * The type pool and result pool are independent (DESIGN.md §4.2) — a
 * result-pool win additionally requires the type pick to match, since the
 * two pools share one flat set of 16 bucket labels and a bucket string
 * alone (e.g. "0") doesn't disambiguate run from pass.
 */
export function computeSettlement(
  wagers: Map<string, CountedWager>,
  result: { type: PlayType; bucket: string },
): SettlementSummary {
  const typeOutcome = settlePool(
    wagers,
    (w) => w.typeStake,
    (w) => w.typePick === result.type,
  );
  const resultOutcome = settlePool(
    wagers,
    (w) => w.resultStake,
    (w) => w.typePick === result.type && w.bucketPick === result.bucket,
  );

  const players: PlayerSettlement[] = [];
  for (const wager of wagers.values()) {
    const typePayout = typeOutcome.payouts.get(wager.playerUid) ?? 0;
    const resultPayout = resultOutcome.payouts.get(wager.playerUid) ?? 0;
    players.push({
      playerUid: wager.playerUid,
      typeStake: wager.typeStake,
      resultStake: wager.resultStake,
      typePayout,
      resultPayout,
      delta: typePayout + resultPayout - wager.typeStake - wager.resultStake,
      typeCorrect: wager.typePick === result.type,
      resultCorrect: wager.typePick === result.type && wager.bucketPick === result.bucket,
    });
  }

  return {
    typePool: typeOutcome.pool,
    resultPool: resultOutcome.pool,
    typeWinners: typeOutcome.winnerCount,
    resultWinners: resultOutcome.winnerCount,
    players,
  };
}

/** playId is a zero-padded sequence number (DESIGN.md §6) — "0001", "0002", ... */
export function adjacentPlayId(playId: string, delta: 1 | -1): string | null {
  const width = playId.length;
  const next = parseInt(playId, 10) + delta;
  if (next < 1) return null;
  return String(next).padStart(width, "0");
}
