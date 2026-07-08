import { describe, expect, it } from "vitest";
import { computeQuorum, evaluateAcceptance } from "./quorum";

const QUORUM_PARAMS = { reportQuorumMin: 15, reportQuorumShare: 0.6 };
const MARGIN_PARAMS = { reportMarginAutoTrust: 0.65, reportMarginSuspicious: 0.75 };

describe("computeQuorum", () => {
  it("uses the absolute floor for large games", () => {
    expect(computeQuorum(1000, QUORUM_PARAMS)).toBe(15);
  });

  it("scales down for small games — DESIGN.md §12.6's 20-person friend game", () => {
    expect(computeQuorum(20, QUORUM_PARAMS)).toBe(12);
  });

  it("takes the lesser of floor and share at the crossover", () => {
    expect(computeQuorum(25, QUORUM_PARAMS)).toBe(15); // ceil(25*0.6)=15, min(15,15)
    expect(computeQuorum(26, QUORUM_PARAMS)).toBe(15); // ceil(26*0.6)=16 > floor
  });

  it("a 1-person pool needs exactly 1 reporter", () => {
    expect(computeQuorum(1, QUORUM_PARAMS)).toBe(1);
  });

  it("never returns less than 1 — silence must not auto-trust", () => {
    expect(computeQuorum(0, QUORUM_PARAMS)).toBe(1);
  });
});

describe("evaluateAcceptance", () => {
  it("rejects below quorum regardless of margin", () => {
    expect(evaluateAcceptance(9, 1.0, 10, MARGIN_PARAMS)).toEqual({ kind: "reject" });
  });

  it("rejects a thin majority below the auto-trust margin", () => {
    expect(evaluateAcceptance(20, 0.55, 10, MARGIN_PARAMS)).toEqual({ kind: "reject" });
  });

  it("accepts-with-suspicion inside the suspicious band", () => {
    expect(evaluateAcceptance(20, 0.7, 10, MARGIN_PARAMS)).toEqual({ kind: "accept", suspicious: true });
  });

  it("accepts exactly at the auto-trust margin (suspicious)", () => {
    expect(evaluateAcceptance(20, 0.65, 10, MARGIN_PARAMS)).toEqual({ kind: "accept", suspicious: true });
  });

  it("accepts cleanly at/above the suspicious ceiling", () => {
    expect(evaluateAcceptance(20, 0.75, 10, MARGIN_PARAMS)).toEqual({ kind: "accept", suspicious: false });
    expect(evaluateAcceptance(20, 0.95, 10, MARGIN_PARAMS)).toEqual({ kind: "accept", suspicious: false });
  });

  it("accepts exactly at quorum", () => {
    expect(evaluateAcceptance(10, 0.9, 10, MARGIN_PARAMS)).toEqual({ kind: "accept", suspicious: false });
  });
});
