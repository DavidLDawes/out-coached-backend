// DESIGN.md §12.2 — moment-signal burst detection. Pure by convention (no
// Firebase imports): a real broadcast moment produces a tight cluster of
// presses because everyone is reacting to the same event; scattered noise
// doesn't. The crowd moment is the instant the distinct-presser count within
// a trailing window first crosses threshold.

export interface SignalLike {
  uid: string;
  atMillis: number;
}

/**
 * Returns the millis of the threshold-crossing signal — the earliest signal
 * at which `minDistinct` distinct uids have signaled within the trailing
 * `windowMillis` (inclusive of the crossing signal itself) — or null if no
 * burst exists in the input. Repeat presses by one uid count once per window.
 */
export function detectBurst(
  signals: SignalLike[],
  windowMillis: number,
  minDistinct: number,
): number | null {
  if (minDistinct <= 0) return null;
  const sorted = [...signals].sort((a, b) => a.atMillis - b.atMillis);
  for (let i = 0; i < sorted.length; i++) {
    const windowStart = sorted[i].atMillis - windowMillis;
    const uids = new Set<string>();
    for (let j = i; j >= 0 && sorted[j].atMillis >= windowStart; j--) {
      uids.add(sorted[j].uid);
    }
    if (uids.size >= minDistinct) return sorted[i].atMillis;
  }
  return null;
}
