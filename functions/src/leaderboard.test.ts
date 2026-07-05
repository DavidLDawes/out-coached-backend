import { describe, expect, it } from "vitest";
import { computeAccuracy, computeTopBalance, type PlayerSummary } from "./leaderboard";

function player(uid: string, balance: number, typeWrong: number): PlayerSummary {
  return { uid, name: uid, balance, typeWrong };
}

describe("computeTopBalance", () => {
  it("sorts by balance descending and caps at 10", () => {
    const players = Array.from({ length: 15 }, (_, i) => player(`p${i}`, i * 100, 0));
    const top = computeTopBalance(players);
    expect(top).toHaveLength(10);
    expect(top[0].uid).toBe("p14");
    expect(top[0].balance).toBe(1400);
    expect(top[9].uid).toBe("p5");
  });
});

describe("computeAccuracy", () => {
  it("shows a perfect-count banner when more than 5 players are at zero wrong", () => {
    const players = [
      ...Array.from({ length: 8 }, (_, i) => player(`perfect${i}`, 1000, 0)),
      player("wrong1", 1000, 2),
    ];
    const accuracy = computeAccuracy(players);
    expect(accuracy.mode).toBe("perfect-count");
    expect(accuracy.perfectCount).toBe(8);
    expect(accuracy.entries).toBeUndefined();
  });

  it("switches to a top-5 board once the perfect group is small enough", () => {
    const players = [
      player("a", 1000, 0),
      player("b", 1000, 0),
      player("c", 1000, 1),
      player("d", 1000, 2),
      player("e", 1000, 3),
      player("f", 1000, 4),
    ];
    const accuracy = computeAccuracy(players);
    expect(accuracy.mode).toBe("top5");
    expect(accuracy.entries).toHaveLength(5);
    expect(accuracy.entries?.map((e) => e.uid)).toEqual(["a", "b", "c", "d", "e"]);
    expect(accuracy.tieNote).toBeUndefined();
  });

  it("adds a tie note when players beyond the top 5 share the boundary wrong-count", () => {
    const players = [
      player("a", 1000, 0),
      player("b", 1000, 1),
      player("c", 1000, 2),
      player("d", 1000, 3),
      player("e", 1000, 3),
      player("f", 1000, 3), // ties with d/e at the 5th-place boundary but cut off
    ];
    const accuracy = computeAccuracy(players);
    expect(accuracy.mode).toBe("top5");
    expect(accuracy.entries).toHaveLength(5);
    expect(accuracy.tieNote).toBe("…and 3 tied at 3 wrong");
  });

  it("has no tie note when the whole field fits within top 5", () => {
    const players = [player("a", 1000, 1), player("b", 1000, 2)];
    const accuracy = computeAccuracy(players);
    expect(accuracy.mode).toBe("top5");
    expect(accuracy.entries).toHaveLength(2);
    expect(accuracy.tieNote).toBeUndefined();
  });

  it("treats exactly 5 perfect players as a real top-5, not a perfect-count banner", () => {
    const players = Array.from({ length: 5 }, (_, i) => player(`p${i}`, 1000, 0));
    const accuracy = computeAccuracy(players);
    expect(accuracy.mode).toBe("top5");
    expect(accuracy.entries).toHaveLength(5);
  });
});
