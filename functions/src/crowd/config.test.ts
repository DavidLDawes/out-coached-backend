import { describe, expect, it } from "vitest";
import { validateGameConfig } from "./config";

describe("validateGameConfig", () => {
  it("accepts an empty partial config", () => {
    expect(validateGameConfig({})).toBeNull();
  });

  it("accepts a fully-specified valid config", () => {
    expect(
      validateGameConfig({
        lockWindowSeconds: 15,
        grubstake: 1000,
        minStake: 1,
        buckets: { run: ["0", "1"], pass: ["sack", "0"] },
      }),
    ).toBeNull();
  });

  it.each([4, 61, Number.NaN])("rejects lockWindowSeconds out of [5, 60]: %s", (v) => {
    expect(validateGameConfig({ lockWindowSeconds: v })).toMatch(/lockWindowSeconds/);
  });

  it.each([0, -1, 1.5])("rejects a non-positive-integer grubstake: %s", (v) => {
    expect(validateGameConfig({ grubstake: v })).toMatch(/grubstake/);
  });

  it.each([0, -1, 2.5])("rejects a non-positive-integer minStake: %s", (v) => {
    expect(validateGameConfig({ minStake: v })).toMatch(/minStake/);
  });

  it("rejects an empty run bucket list", () => {
    expect(validateGameConfig({ buckets: { run: [], pass: ["sack"] } })).toMatch(/buckets\.run/);
  });

  it("rejects an empty pass bucket list", () => {
    expect(validateGameConfig({ buckets: { run: ["0"], pass: [] } })).toMatch(/buckets\.pass/);
  });

  it("rejects a bucket list containing an empty string", () => {
    expect(validateGameConfig({ buckets: { run: ["0", ""], pass: ["sack"] } })).toMatch(/buckets\.run/);
  });
});
