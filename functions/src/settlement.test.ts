import { describe, expect, it } from "vitest";
import {
  adjacentPlayId,
  clampStakeToBalance,
  computeSettlement,
  selectCountedWagers,
  settlePool,
  type CountedWager,
  type WagerLike,
} from "./settlement";

function wager(
  playerUid: string,
  typePick: "run" | "pass",
  bucketPick: string,
  typeStake: number,
  resultStake: number,
): CountedWager {
  return { playerUid, typePick, bucketPick, typeStake, resultStake };
}

describe("settlePool — DESIGN.md §4.3 worked example", () => {
  it("splits the type pool pro-rata among winners, burning floor breakage", () => {
    const wagers = new Map<string, CountedWager>([
      ["A", wager("A", "run", "3", 100, 0)],
      ["B", wager("B", "run", "1", 50, 0)],
      ["C", wager("C", "pass", "0", 200, 0)],
      ["D", wager("D", "pass", "sack", 50, 0)],
    ]);

    const outcome = settlePool(
      wagers,
      (w) => w.typeStake,
      (w) => w.typePick === "run",
    );

    expect(outcome.pool).toBe(400);
    expect(outcome.winningStakes).toBe(150);
    expect(outcome.winnerCount).toBe(2);
    expect(outcome.payouts.get("A")).toBe(266);
    expect(outcome.payouts.get("B")).toBe(133);
    expect(outcome.payouts.get("C")).toBe(0);
    expect(outcome.payouts.get("D")).toBe(0);
    // 266 + 133 = 399 < 400 — the floor breakage is burned, never overpaid.
    expect((outcome.payouts.get("A") ?? 0) + (outcome.payouts.get("B") ?? 0)).toBeLessThan(
      outcome.pool,
    );
  });
});

describe("settlePool — edge cases", () => {
  it("pushes (refunds every stake) when nobody picked the winning side", () => {
    const wagers = new Map<string, CountedWager>([
      ["A", wager("A", "run", "3", 100, 0)],
      ["B", wager("B", "run", "1", 50, 0)],
    ]);

    const outcome = settlePool(
      wagers,
      (w) => w.typeStake,
      (w) => w.typePick === "pass",
    );

    expect(outcome.winningStakes).toBe(0);
    expect(outcome.payouts.get("A")).toBe(100);
    expect(outcome.payouts.get("B")).toBe(50);
  });

  it("degenerates to returning every stake when everyone wins", () => {
    const wagers = new Map<string, CountedWager>([
      ["A", wager("A", "run", "3", 100, 0)],
      ["B", wager("B", "run", "1", 50, 0)],
    ]);

    const outcome = settlePool(
      wagers,
      (w) => w.typeStake,
      (w) => w.typePick === "run",
    );

    expect(outcome.payouts.get("A")).toBe(100);
    expect(outcome.payouts.get("B")).toBe(50);
  });

  it("ignores players who staked 0 on this pool", () => {
    const wagers = new Map<string, CountedWager>([["A", wager("A", "run", "3", 0, 0)]]);
    const outcome = settlePool(
      wagers,
      (w) => w.typeStake,
      (w) => w.typePick === "run",
    );
    expect(outcome.pool).toBe(0);
    expect(outcome.payouts.size).toBe(0);
  });
});

describe("computeSettlement", () => {
  it("requires both type and bucket to match for a result-pool win (buckets aren't unique across types)", () => {
    // Both run and pass bucket lists contain "0" — a run pick of "0" must
    // NOT win when the actual result is pass/"0".
    const wagers = new Map<string, CountedWager>([
      ["A", wager("A", "run", "0", 10, 40)],
      ["B", wager("B", "pass", "0", 10, 60)],
    ]);

    const summary = computeSettlement(wagers, { type: "pass", bucket: "0" });

    const a = summary.players.find((p) => p.playerUid === "A")!;
    const b = summary.players.find((p) => p.playerUid === "B")!;
    expect(a.resultCorrect).toBe(false);
    expect(b.resultCorrect).toBe(true);
    expect(a.resultPayout).toBe(0);
    expect(b.resultPayout).toBe(100); // sole winner takes the whole result pool
  });

  it("computes net delta as payouts minus stakes", () => {
    const wagers = new Map<string, CountedWager>([["A", wager("A", "run", "3", 100, 50)]]);
    const summary = computeSettlement(wagers, { type: "run", bucket: "3" });
    const a = summary.players[0];
    // Sole participant in both pools -> wins everything back (degenerate case).
    expect(a.typePayout).toBe(100);
    expect(a.resultPayout).toBe(50);
    expect(a.delta).toBe(0);
  });
});

describe("selectCountedWagers — DESIGN.md §2.1 retroactive cutoff", () => {
  const CUTOFF = 10_000;

  function rev(playerUid: string, placedAtMillis: number, typeStake: number): WagerLike {
    return { playerUid, typePick: "run", bucketPick: "0", typeStake, resultStake: 0, placedAtMillis };
  }

  it("counts the latest revision at or before the cutoff, ignoring later ones", () => {
    const revisions = [
      rev("A", 1_000, 10),
      rev("A", 5_000, 20), // this one should count
      rev("A", 15_000, 999), // after cutoff — must not apply
    ];
    const counted = selectCountedWagers(revisions, CUTOFF);
    expect(counted.get("A")?.typeStake).toBe(20);
  });

  it("excludes a player whose first-ever revision is after the cutoff", () => {
    const revisions = [rev("A", 15_000, 10)];
    const counted = selectCountedWagers(revisions, CUTOFF);
    expect(counted.has("A")).toBe(false);
  });

  it("treats a revision exactly at the cutoff as counted (inclusive)", () => {
    const revisions = [rev("A", CUTOFF, 10)];
    const counted = selectCountedWagers(revisions, CUTOFF);
    expect(counted.get("A")?.typeStake).toBe(10);
  });
});

describe("clampStakeToBalance", () => {
  it("passes through when stakes already fit the balance", () => {
    const w = wager("A", "run", "0", 40, 40);
    expect(clampStakeToBalance(w, 100)).toEqual(w);
  });

  it("scales both stakes down proportionally when they exceed balance", () => {
    const w = wager("A", "run", "0", 60, 40);
    const clamped = clampStakeToBalance(w, 50);
    expect(clamped.typeStake + clamped.resultStake).toBe(50);
    expect(clamped.typeStake).toBe(30); // floor(60 * 50 / 100)
    expect(clamped.resultStake).toBe(20);
  });

  it("zeroes both stakes when balance is exhausted", () => {
    const w = wager("A", "run", "0", 10, 10);
    const clamped = clampStakeToBalance(w, 0);
    expect(clamped.typeStake).toBe(0);
    expect(clamped.resultStake).toBe(0);
  });
});

describe("adjacentPlayId", () => {
  it("increments and decrements preserving zero-padded width", () => {
    expect(adjacentPlayId("0007", 1)).toBe("0008");
    expect(adjacentPlayId("0007", -1)).toBe("0006");
  });

  it("returns null decrementing before the first play", () => {
    expect(adjacentPlayId("0001", -1)).toBeNull();
  });
});
