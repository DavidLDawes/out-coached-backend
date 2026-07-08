import { describe, expect, it } from "vitest";
import { detectBurst } from "./burst";

const WINDOW = 2_000;

function sig(uid: string, atMillis: number) {
  return { uid, atMillis };
}

describe("detectBurst", () => {
  it("returns null with no signals", () => {
    expect(detectBurst([], WINDOW, 3)).toBeNull();
  });

  it("fires at the exact threshold-crossing signal", () => {
    const signals = [sig("a", 1000), sig("b", 1500), sig("c", 2000)];
    expect(detectBurst(signals, WINDOW, 3)).toBe(2000);
  });

  it("does not fire below threshold", () => {
    const signals = [sig("a", 1000), sig("b", 1500)];
    expect(detectBurst(signals, WINDOW, 3)).toBeNull();
  });

  it("counts a repeat presser once", () => {
    const signals = [sig("a", 1000), sig("a", 1200), sig("a", 1400), sig("b", 1600)];
    expect(detectBurst(signals, WINDOW, 3)).toBeNull();
  });

  it("ignores scattered signals outside the trailing window", () => {
    // Three distinct uids, but never three within any 2s trailing window.
    const signals = [sig("a", 0), sig("b", 5_000), sig("c", 10_000)];
    expect(detectBurst(signals, WINDOW, 3)).toBeNull();
  });

  it("finds a burst after earlier scattered noise", () => {
    const signals = [
      sig("noise1", 0),
      sig("noise2", 10_000),
      sig("a", 60_000),
      sig("b", 60_500),
      sig("c", 61_000),
    ];
    expect(detectBurst(signals, WINDOW, 3)).toBe(61_000);
  });

  it("includes a signal exactly at the window boundary", () => {
    // windowStart = 3000 - 2000 = 1000; the signal at 1000 is inclusive.
    const signals = [sig("a", 1000), sig("b", 2000), sig("c", 3000)];
    expect(detectBurst(signals, WINDOW, 3)).toBe(3000);
  });

  it("returns the first crossing when multiple bursts exist", () => {
    const signals = [
      sig("a", 1000),
      sig("b", 1100),
      sig("c", 1200),
      sig("d", 9000),
      sig("e", 9100),
      sig("f", 9200),
    ];
    expect(detectBurst(signals, WINDOW, 3)).toBe(1200);
  });

  it("handles unsorted input", () => {
    const signals = [sig("c", 2000), sig("a", 1000), sig("b", 1500)];
    expect(detectBurst(signals, WINDOW, 3)).toBe(2000);
  });

  it("threshold of 1 fires on the first signal", () => {
    expect(detectBurst([sig("a", 42)], WINDOW, 1)).toBe(42);
  });

  it("threshold of 0 or below never fires", () => {
    expect(detectBurst([sig("a", 42)], WINDOW, 0)).toBeNull();
  });
});
