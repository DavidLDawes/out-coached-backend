// DESIGN.md §12.4 — the reporting-accuracy reward/penalty table. Pure by
// convention (no Firebase imports); every row of the §12.4 table has a
// matching test in reportingLedger.test.ts, the same way §4.3's worked
// examples back settlement.ts.

import type { PlayType } from "../types";

export interface ResultDistanceContext {
  runLadder: string[]; // config.buckets.run — fully ordinal
  passLadder: string[]; // config.buckets.pass minus the categorical one-offs
  passCategorical: string[]; // e.g. incomplete/intercepted/sack/scramble
  adjacency: string[][]; // forgiven categorical pairs, e.g. [["sack","scramble"]]
}

export type ResultDistance =
  | { kind: "exact" }
  | { kind: "near" } // ≤2 apart on an ordinal ladder, or a forgiven categorical pair
  | { kind: "far" };

export function classifyResultDistance(
  reported: string,
  official: string,
  officialType: PlayType,
  ctx: ResultDistanceContext,
): ResultDistance {
  if (reported === official) return { kind: "exact" };

  for (const pair of ctx.adjacency) {
    if (pair.includes(reported) && pair.includes(official)) return { kind: "near" };
  }

  const ladder = officialType === "run" ? ctx.runLadder : ctx.passLadder;
  const officialIdx = ladder.indexOf(official);
  const reportedIdx = ladder.indexOf(reported);
  if (officialIdx >= 0 && reportedIdx >= 0) {
    return Math.abs(officialIdx - reportedIdx) <= 2 ? { kind: "near" } : { kind: "far" };
  }

  // Any other categorical mismatch — categorical vs. yardage band, or an
  // unforgiven categorical pair — is "far" per §12.4.
  return { kind: "far" };
}

export interface ReporterInput {
  uid: string;
  reportedValue: string;
  /** The reporter's own counted wager pick for this pool, if any. */
  wagerPick?: string;
}

export interface ReportingOutcome {
  uid: string;
  delta: number;
  reason: "reporting_bonus" | "reporting_penalty";
}

/**
 * Type vote (§12.4): agreement earns the bonus; disagreement is penalized
 * only when the reporter's own wager matches their bad report. Honest
 * misses with nothing riding on them cost nothing (and earn nothing).
 */
export function evaluateTypeReport(
  input: ReporterInput,
  officialType: PlayType,
  bonusCredits: number,
): ReportingOutcome | null {
  if (input.reportedValue === officialType) {
    return { uid: input.uid, delta: bonusCredits, reason: "reporting_bonus" };
  }
  if (input.wagerPick !== undefined && input.wagerPick === input.reportedValue) {
    return { uid: input.uid, delta: -bonusCredits, reason: "reporting_penalty" };
  }
  return null;
}

/**
 * Result vote (§12.4): exact match rewards; near misses (≤2 ordinal bands,
 * or the forgiven Sack↔Scramble pair) are never penalized regardless of the
 * wager; far misses are penalized only when they match the reporter's own
 * wager.
 */
export function evaluateResultReport(
  input: ReporterInput,
  officialBucket: string,
  officialType: PlayType,
  ctx: ResultDistanceContext,
  bonusCredits: number,
): ReportingOutcome | null {
  const distance = classifyResultDistance(input.reportedValue, officialBucket, officialType, ctx);
  if (distance.kind === "exact") {
    return { uid: input.uid, delta: bonusCredits, reason: "reporting_bonus" };
  }
  if (distance.kind === "near") return null;
  if (input.wagerPick !== undefined && input.wagerPick === input.reportedValue) {
    return { uid: input.uid, delta: -bonusCredits, reason: "reporting_penalty" };
  }
  return null;
}

/** Splits a pass bucket list into its ordinal ladder using the categorical set. */
export function passLadderOf(passBuckets: string[], passCategorical: string[]): string[] {
  return passBuckets.filter((b) => !passCategorical.includes(b));
}
