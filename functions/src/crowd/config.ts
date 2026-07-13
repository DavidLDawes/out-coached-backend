// DESIGN.md §12.5 crowd tunables with their starting-guess defaults. All of
// these are per-game config, resolved here so pre-crowd game documents (which
// carry none of the fields) behave identically to crowdMode: "off".
//
// The numbers are explicitly calibration targets for the shadow-mode phase
// (PLAN.md CR-5, DESIGN.md §12.7) — change them there from data, not here
// from taste, and update DESIGN.md alongside.

import type { CrowdMode, GameConfig } from "../types";

export interface CrowdConfig {
  crowdMode: CrowdMode;
  snapBurstWindowSeconds: number;
  snapBurstMinReports: number;
  momentBurstMinReports: number;
  endGameGraceSeconds: number;
  joinWindowSeconds: number;
  typeVoteStableShare: number;
  voteStabilitySeconds: number;
  typeVoteTimeoutSeconds: number;
  resultVoteTimeoutSeconds: number;
  reportQuorumMin: number;
  reportQuorumShare: number;
  reportMarginAutoTrust: number;
  reportMarginSuspicious: number;
  reportingBonusCredits: number;
  passBucketAdjacency: string[][];
  passCategoricalBuckets: string[];
  stakeConcentrationCapFraction: number;
}

export const CROWD_DEFAULTS: CrowdConfig = {
  crowdMode: "off",
  snapBurstWindowSeconds: 2,
  snapBurstMinReports: 5,
  momentBurstMinReports: 3,
  endGameGraceSeconds: 120,
  joinWindowSeconds: 300,
  typeVoteStableShare: 0.8,
  voteStabilitySeconds: 3,
  typeVoteTimeoutSeconds: 20,
  resultVoteTimeoutSeconds: 40,
  reportQuorumMin: 15,
  reportQuorumShare: 0.6,
  reportMarginAutoTrust: 0.65,
  reportMarginSuspicious: 0.75,
  reportingBonusCredits: 3,
  passBucketAdjacency: [["sack", "scramble"]],
  passCategoricalBuckets: ["incomplete", "intercepted", "sack", "scramble"],
  stakeConcentrationCapFraction: 0.25,
};

/**
 * Bounds-checks the subset of GameConfig that scheduleGame accepts from a
 * caller (§12.10). Only the core fields are checked here — crowd tunables
 * default sanely via resolveCrowdConfig and aren't operator-facing yet.
 * Returns a human-readable reason, or null if the partial config is
 * acceptable to merge over the defaults.
 */
export function validateGameConfig(config: Partial<GameConfig>): string | null {
  if (config.lockWindowSeconds !== undefined) {
    if (!Number.isFinite(config.lockWindowSeconds) || config.lockWindowSeconds < 5 || config.lockWindowSeconds > 60) {
      return "lockWindowSeconds must be between 5 and 60.";
    }
  }
  if (config.grubstake !== undefined) {
    if (!Number.isInteger(config.grubstake) || config.grubstake < 1) {
      return "grubstake must be a positive integer.";
    }
  }
  if (config.minStake !== undefined) {
    if (!Number.isInteger(config.minStake) || config.minStake < 1) {
      return "minStake must be a positive integer.";
    }
  }
  if (config.buckets !== undefined) {
    const { run, pass } = config.buckets;
    if (!Array.isArray(run) || run.length === 0 || !run.every((b) => typeof b === "string" && b.length > 0)) {
      return "buckets.run must be a non-empty array of strings.";
    }
    if (!Array.isArray(pass) || pass.length === 0 || !pass.every((b) => typeof b === "string" && b.length > 0)) {
      return "buckets.pass must be a non-empty array of strings.";
    }
  }
  return null;
}

export function resolveCrowdConfig(config: GameConfig): CrowdConfig {
  return {
    crowdMode: config.crowdMode ?? CROWD_DEFAULTS.crowdMode,
    snapBurstWindowSeconds: config.snapBurstWindowSeconds ?? CROWD_DEFAULTS.snapBurstWindowSeconds,
    snapBurstMinReports: config.snapBurstMinReports ?? CROWD_DEFAULTS.snapBurstMinReports,
    momentBurstMinReports: config.momentBurstMinReports ?? CROWD_DEFAULTS.momentBurstMinReports,
    endGameGraceSeconds: config.endGameGraceSeconds ?? CROWD_DEFAULTS.endGameGraceSeconds,
    joinWindowSeconds: config.joinWindowSeconds ?? CROWD_DEFAULTS.joinWindowSeconds,
    typeVoteStableShare: config.typeVoteStableShare ?? CROWD_DEFAULTS.typeVoteStableShare,
    voteStabilitySeconds: config.voteStabilitySeconds ?? CROWD_DEFAULTS.voteStabilitySeconds,
    typeVoteTimeoutSeconds: config.typeVoteTimeoutSeconds ?? CROWD_DEFAULTS.typeVoteTimeoutSeconds,
    resultVoteTimeoutSeconds: config.resultVoteTimeoutSeconds ?? CROWD_DEFAULTS.resultVoteTimeoutSeconds,
    reportQuorumMin: config.reportQuorumMin ?? CROWD_DEFAULTS.reportQuorumMin,
    reportQuorumShare: config.reportQuorumShare ?? CROWD_DEFAULTS.reportQuorumShare,
    reportMarginAutoTrust: config.reportMarginAutoTrust ?? CROWD_DEFAULTS.reportMarginAutoTrust,
    reportMarginSuspicious: config.reportMarginSuspicious ?? CROWD_DEFAULTS.reportMarginSuspicious,
    reportingBonusCredits: config.reportingBonusCredits ?? CROWD_DEFAULTS.reportingBonusCredits,
    passBucketAdjacency: config.passBucketAdjacency ?? CROWD_DEFAULTS.passBucketAdjacency,
    passCategoricalBuckets: config.passCategoricalBuckets ?? CROWD_DEFAULTS.passCategoricalBuckets,
    stakeConcentrationCapFraction:
      config.stakeConcentrationCapFraction ?? CROWD_DEFAULTS.stakeConcentrationCapFraction,
  };
}
