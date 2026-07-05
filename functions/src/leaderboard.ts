// Pure leaderboard computation — DESIGN.md §8. No Firebase imports, unit
// testable directly. handlers.ts wires this to a real player collection scan.

import type { LeaderboardAccuracy, LeaderboardAccuracyEntry, LeaderboardBalanceEntry } from "./types";

export interface PlayerSummary {
  uid: string;
  name: string;
  balance: number;
  typeWrong: number;
}

const TOP_BALANCE_SIZE = 10;
const TOP_ACCURACY_SIZE = 5;

export function computeTopBalance(players: PlayerSummary[]): LeaderboardBalanceEntry[] {
  return [...players]
    .sort((a, b) => b.balance - a.balance)
    .slice(0, TOP_BALANCE_SIZE)
    .map((p) => ({ uid: p.uid, name: p.name, balance: p.balance }));
}

/**
 * DESIGN.md §8: early in a game, many players sit at zero wrong — showing
 * an arbitrary top 5 of them is meaningless, so instead show a perfect-count
 * banner until the perfect group is small enough (<= 5) for a real top 5 to
 * make sense. Known, accepted gap carried over from the design: this counts
 * every player equally regardless of how many plays they've actually picked
 * (skipped != wrong) — fine for v1 per DESIGN.md §8, revisit with a
 * participation floor once games exceed ~100 plays.
 */
export function computeAccuracy(players: PlayerSummary[]): LeaderboardAccuracy {
  const perfect = players.filter((p) => p.typeWrong === 0);
  if (perfect.length > TOP_ACCURACY_SIZE) {
    return { mode: "perfect-count", perfectCount: perfect.length };
  }

  const sorted = [...players].sort((a, b) => a.typeWrong - b.typeWrong);
  const entries: LeaderboardAccuracyEntry[] = sorted
    .slice(0, TOP_ACCURACY_SIZE)
    .map((p) => ({ uid: p.uid, name: p.name, wrong: p.typeWrong }));

  const accuracy: LeaderboardAccuracy = { mode: "top5", entries };

  if (sorted.length > TOP_ACCURACY_SIZE) {
    const boundaryWrong = sorted[TOP_ACCURACY_SIZE - 1].typeWrong;
    const totalAtBoundary = sorted.filter((p) => p.typeWrong === boundaryWrong).length;
    const shownAtBoundary = entries.filter((e) => e.wrong === boundaryWrong).length;
    if (totalAtBoundary > shownAtBoundary) {
      accuracy.tieNote = `…and ${totalAtBoundary} tied at ${boundaryWrong} wrong`;
    }
  }

  return accuracy;
}
