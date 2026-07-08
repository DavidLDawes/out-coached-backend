// DESIGN.md §12.3 — type/result vote tallying and the finalize rule. Pure by
// convention (no Firebase imports). Reports are corrigible: only each uid's
// latest report counts, same latest-per-player shape as wager revisions.

export interface ReportLike {
  uid: string;
  value: string;
  atMillis: number;
}

export interface VoteTally {
  /** Distinct reporters (latest report per uid). */
  total: number;
  /** Winning value and its count, or null when there are no reports. */
  top: { value: string; count: number } | null;
  /** top.count / total, or 0 when empty. */
  share: number;
  /** Millis of the newest counted report, for the stability check. */
  newestAtMillis: number;
}

export function latestPerUid(reports: ReportLike[]): Map<string, ReportLike> {
  const latest = new Map<string, ReportLike>();
  for (const report of reports) {
    const existing = latest.get(report.uid);
    if (!existing || report.atMillis > existing.atMillis) latest.set(report.uid, report);
  }
  return latest;
}

export function tallyVote(reports: ReportLike[]): VoteTally {
  const latest = latestPerUid(reports);
  const counts = new Map<string, number>();
  let newestAtMillis = 0;
  for (const report of latest.values()) {
    counts.set(report.value, (counts.get(report.value) ?? 0) + 1);
    if (report.atMillis > newestAtMillis) newestAtMillis = report.atMillis;
  }
  let top: { value: string; count: number } | null = null;
  for (const [value, count] of counts) {
    if (!top || count > top.count) top = { value, count };
  }
  const total = latest.size;
  return { total, top, share: top && total > 0 ? top.count / total : 0, newestAtMillis };
}

export interface FinalizeParams {
  nowMillis: number;
  /** Millis at which the vote times out (snapAt + configured timeout). */
  timeoutAtMillis: number;
  stableShare: number; // e.g. 0.8
  stabilityMillis: number; // supermajority must hold this long with no new reports
}

export type FinalizeDecision =
  | { kind: "wait" }
  | { kind: "finalize"; value: string; share: number; total: number }
  | { kind: "no-reports" };

/**
 * §12.3: finalize on whichever comes first — a stable supermajority (share
 * >= stableShare, unchanged for stabilityMillis) or the timeout (majority at
 * that point wins). Quorum/margin acceptance is the caller's job (§12.6) —
 * this only decides *whether the vote is over* and what it said.
 */
export function evaluateVote(tally: VoteTally, params: FinalizeParams): FinalizeDecision {
  if (tally.total === 0 || !tally.top) {
    return params.nowMillis >= params.timeoutAtMillis ? { kind: "no-reports" } : { kind: "wait" };
  }
  const stableSince = tally.newestAtMillis + params.stabilityMillis;
  const stableSupermajority = tally.share >= params.stableShare && params.nowMillis >= stableSince;
  if (stableSupermajority || params.nowMillis >= params.timeoutAtMillis) {
    return { kind: "finalize", value: tally.top.value, share: tally.share, total: tally.total };
  }
  return { kind: "wait" };
}
