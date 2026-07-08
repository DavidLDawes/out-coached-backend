// DESIGN.md §12.6 — quorum and margin acceptance for a finalized vote. Pure
// by convention (no Firebase imports). The vote mechanics (§12.3) decide
// what the crowd said; this decides whether to believe it.

export interface QuorumParams {
  reportQuorumMin: number; // absolute floor for large games (e.g. 15)
  reportQuorumShare: number; // small-game scaling fraction (e.g. 0.6)
}

/**
 * §12.6: quorum is the lesser of the absolute floor and a share of that
 * pool's currently-eligible players — large games are protected by the
 * floor, small games get a bar sized to who is actually there. Always at
 * least 1 (an empty quorum would auto-trust silence).
 */
export function computeQuorum(eligibleCount: number, params: QuorumParams): number {
  const scaled = Math.ceil(eligibleCount * params.reportQuorumShare);
  return Math.max(1, Math.min(params.reportQuorumMin, scaled));
}

export interface MarginParams {
  reportMarginAutoTrust: number; // e.g. 0.65
  reportMarginSuspicious: number; // e.g. 0.75 — flag when share is in [autoTrust, suspicious)
}

export type MarginVerdict =
  | { kind: "reject" } // below quorum or below the auto-trust margin — VOID per §12.6
  | { kind: "accept"; suspicious: boolean };

export function evaluateAcceptance(
  reporterCount: number,
  topShare: number,
  quorum: number,
  params: MarginParams,
): MarginVerdict {
  if (reporterCount < quorum) return { kind: "reject" };
  if (topShare < params.reportMarginAutoTrust) return { kind: "reject" };
  return { kind: "accept", suspicious: topShare < params.reportMarginSuspicious };
}
