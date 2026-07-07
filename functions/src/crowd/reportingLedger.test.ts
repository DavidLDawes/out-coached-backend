// Every row of DESIGN.md §12.4's reward/penalty table appears here as a
// named case, the same way §4.3's worked examples back settlement.test.ts.

import { describe, expect, it } from "vitest";
import {
  classifyResultDistance,
  evaluateResultReport,
  evaluateTypeReport,
  passLadderOf,
  type ResultDistanceContext,
} from "./reportingLedger";

const RUN_LADDER = ["loss", "0", "1", "2", "3", "4", "5+"];
const PASS_BUCKETS = [
  "incomplete",
  "intercepted",
  "sack",
  "scramble",
  "<5",
  "5-7",
  "8-10",
  "11-15",
  "16-20",
  "21+",
];
const PASS_CATEGORICAL = ["incomplete", "intercepted", "sack", "scramble"];

const CTX: ResultDistanceContext = {
  runLadder: RUN_LADDER,
  passLadder: passLadderOf(PASS_BUCKETS, PASS_CATEGORICAL),
  passCategorical: PASS_CATEGORICAL,
  adjacency: [["sack", "scramble"]],
};

const BONUS = 3;

describe("passLadderOf", () => {
  it("strips the categorical one-offs, keeping yardage order", () => {
    expect(CTX.passLadder).toEqual(["<5", "5-7", "8-10", "11-15", "16-20", "21+"]);
  });
});

describe("classifyResultDistance", () => {
  it("exact match", () => {
    expect(classifyResultDistance("3", "3", "run", CTX)).toEqual({ kind: "exact" });
  });

  it("1 band apart on the run ladder is near", () => {
    expect(classifyResultDistance("2", "3", "run", CTX)).toEqual({ kind: "near" });
  });

  it("exactly 2 bands apart is near — §12.4's resolved open call", () => {
    expect(classifyResultDistance("1", "3", "run", CTX)).toEqual({ kind: "near" });
  });

  it("3 bands apart is far", () => {
    expect(classifyResultDistance("loss", "3", "run", CTX)).toEqual({ kind: "far" });
  });

  it("Sack↔Scramble is the one forgiven categorical pair, both directions", () => {
    expect(classifyResultDistance("sack", "scramble", "pass", CTX)).toEqual({ kind: "near" });
    expect(classifyResultDistance("scramble", "sack", "pass", CTX)).toEqual({ kind: "near" });
  });

  it("any other categorical pairing is far", () => {
    expect(classifyResultDistance("intercepted", "incomplete", "pass", CTX)).toEqual({ kind: "far" });
    expect(classifyResultDistance("incomplete", "sack", "pass", CTX)).toEqual({ kind: "far" });
  });

  it("categorical vs. a yardage band is far", () => {
    expect(classifyResultDistance("intercepted", "8-10", "pass", CTX)).toEqual({ kind: "far" });
    expect(classifyResultDistance("8-10", "intercepted", "pass", CTX)).toEqual({ kind: "far" });
  });

  it("pass yardage bands use the categorical-stripped ladder", () => {
    expect(classifyResultDistance("<5", "8-10", "pass", CTX)).toEqual({ kind: "near" }); // 2 apart
    expect(classifyResultDistance("<5", "11-15", "pass", CTX)).toEqual({ kind: "far" }); // 3 apart
  });
});

describe("evaluateTypeReport", () => {
  it("agreement earns the bonus", () => {
    expect(evaluateTypeReport({ uid: "a", reportedValue: "run" }, "run", BONUS)).toEqual({
      uid: "a",
      delta: BONUS,
      reason: "reporting_bonus",
    });
  });

  it("self-serving disagreement is penalized — reported run, bet run, official pass", () => {
    expect(
      evaluateTypeReport({ uid: "a", reportedValue: "run", wagerPick: "run" }, "pass", BONUS),
    ).toEqual({ uid: "a", delta: -BONUS, reason: "reporting_penalty" });
  });

  it("honest disagreement with no matching stake costs nothing", () => {
    expect(evaluateTypeReport({ uid: "a", reportedValue: "run", wagerPick: "pass" }, "pass", BONUS)).toBeNull();
    expect(evaluateTypeReport({ uid: "a", reportedValue: "run" }, "pass", BONUS)).toBeNull();
  });
});

describe("evaluateResultReport", () => {
  it("exact match earns the bonus", () => {
    expect(
      evaluateResultReport({ uid: "a", reportedValue: "3" }, "3", "run", CTX, BONUS),
    ).toEqual({ uid: "a", delta: BONUS, reason: "reporting_bonus" });
  });

  it("near miss is never penalized, even when it matches the reporter's wager", () => {
    expect(
      evaluateResultReport({ uid: "a", reportedValue: "2", wagerPick: "2" }, "3", "run", CTX, BONUS),
    ).toBeNull();
  });

  it("Sack↔Scramble miss is never penalized, even wager-matching", () => {
    expect(
      evaluateResultReport(
        { uid: "a", reportedValue: "sack", wagerPick: "sack" },
        "scramble",
        "pass",
        CTX,
        BONUS,
      ),
    ).toBeNull();
  });

  it("far miss matching the reporter's wager is penalized — §12.4's manipulation case", () => {
    expect(
      evaluateResultReport(
        { uid: "a", reportedValue: "21+", wagerPick: "21+" },
        "intercepted",
        "pass",
        CTX,
        BONUS,
      ),
    ).toEqual({ uid: "a", delta: -BONUS, reason: "reporting_penalty" });
  });

  it("far miss without a matching wager is an honest wide miss — no penalty", () => {
    expect(
      evaluateResultReport({ uid: "a", reportedValue: "21+", wagerPick: "<5" }, "intercepted", "pass", CTX, BONUS),
    ).toBeNull();
    expect(
      evaluateResultReport({ uid: "a", reportedValue: "21+" }, "intercepted", "pass", CTX, BONUS),
    ).toBeNull();
  });
});
