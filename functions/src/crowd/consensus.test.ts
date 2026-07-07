import { describe, expect, it } from "vitest";
import { evaluateVote, latestPerUid, tallyVote } from "./consensus";

function rep(uid: string, value: string, atMillis: number) {
  return { uid, value, atMillis };
}

const PARAMS = {
  nowMillis: 100_000,
  timeoutAtMillis: 120_000,
  stableShare: 0.8,
  stabilityMillis: 3_000,
};

describe("latestPerUid", () => {
  it("keeps only each uid's newest report — reports are corrigible", () => {
    const latest = latestPerUid([rep("a", "run", 1000), rep("a", "pass", 2000)]);
    expect(latest.get("a")?.value).toBe("pass");
    expect(latest.size).toBe(1);
  });
});

describe("tallyVote", () => {
  it("tallies distinct reporters and the winning share", () => {
    const tally = tallyVote([
      rep("a", "run", 1000),
      rep("b", "run", 1100),
      rep("c", "pass", 1200),
      rep("d", "run", 1300),
    ]);
    expect(tally.total).toBe(4);
    expect(tally.top).toEqual({ value: "run", count: 3 });
    expect(tally.share).toBe(0.75);
    expect(tally.newestAtMillis).toBe(1300);
  });

  it("a flipped report moves the tally", () => {
    const tally = tallyVote([rep("a", "run", 1000), rep("b", "pass", 1100), rep("a", "pass", 2000)]);
    expect(tally.top).toEqual({ value: "pass", count: 2 });
    expect(tally.share).toBe(1);
  });

  it("empty input tallies to zero", () => {
    const tally = tallyVote([]);
    expect(tally.total).toBe(0);
    expect(tally.top).toBeNull();
    expect(tally.share).toBe(0);
  });
});

describe("evaluateVote", () => {
  it("finalizes a stable supermajority before the timeout", () => {
    // 4/5 = 80% share, newest report 10s old — stable.
    const tally = tallyVote([
      rep("a", "run", 90_000),
      rep("b", "run", 90_100),
      rep("c", "run", 90_200),
      rep("d", "run", 90_300),
      rep("e", "pass", 90_400),
    ]);
    const decision = evaluateVote(tally, PARAMS);
    expect(decision).toEqual({ kind: "finalize", value: "run", share: 0.8, total: 5 });
  });

  it("waits when the supermajority is too fresh to be stable", () => {
    const tally = tallyVote([
      rep("a", "run", 99_000),
      rep("b", "run", 99_100),
      rep("c", "run", 99_200),
      rep("d", "run", 99_300),
      // newest report is only 500ms old at nowMillis=100_000 < 3s stability
      rep("e", "run", 99_500),
    ]);
    expect(evaluateVote(tally, PARAMS).kind).toBe("wait");
  });

  it("waits below the stable share before the timeout", () => {
    // 50/50 split, no timeout yet.
    const tally = tallyVote([rep("a", "run", 90_000), rep("b", "pass", 90_100)]);
    expect(evaluateVote(tally, PARAMS).kind).toBe("wait");
  });

  it("finalizes the bare majority at timeout", () => {
    const tally = tallyVote([
      rep("a", "run", 90_000),
      rep("b", "run", 90_100),
      rep("c", "pass", 90_200),
    ]);
    const decision = evaluateVote(tally, { ...PARAMS, nowMillis: 120_000 });
    expect(decision.kind).toBe("finalize");
    if (decision.kind === "finalize") {
      expect(decision.value).toBe("run");
      expect(decision.share).toBeCloseTo(2 / 3);
    }
  });

  it("a 50/50 tie at timeout still finalizes (one side wins the tally) — acceptance is the quorum layer's call", () => {
    const tally = tallyVote([rep("a", "run", 90_000), rep("b", "pass", 90_100)]);
    const decision = evaluateVote(tally, { ...PARAMS, nowMillis: 120_000 });
    expect(decision.kind).toBe("finalize");
    if (decision.kind === "finalize") expect(decision.share).toBe(0.5);
  });

  it("reports no-reports at timeout with an empty tally", () => {
    expect(evaluateVote(tallyVote([]), { ...PARAMS, nowMillis: 120_000 }).kind).toBe("no-reports");
  });

  it("waits on an empty tally before the timeout", () => {
    expect(evaluateVote(tallyVote([]), PARAMS).kind).toBe("wait");
  });
});
