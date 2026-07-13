import { describe, expect, it } from "vitest";
import { isFirstGoingLive } from "./notifications";

describe("isFirstGoingLive", () => {
  it("fires on the initial scheduled -> live transition", () => {
    expect(isFirstGoingLive("scheduled", "live")).toBe(true);
  });

  it("fires when status was previously undefined (brand-new game doc)", () => {
    expect(isFirstGoingLive(undefined, "live")).toBe(true);
  });

  it("does not fire on halftime -> live (crowd game's second-half snap)", () => {
    expect(isFirstGoingLive("halftime", "live")).toBe(false);
  });

  it("does not fire when already live", () => {
    expect(isFirstGoingLive("live", "live")).toBe(false);
  });

  it("does not fire on transitions that don't land on live", () => {
    expect(isFirstGoingLive("live", "halftime")).toBe(false);
    expect(isFirstGoingLive("live", "final")).toBe(false);
    expect(isFirstGoingLive("scheduled", "halftime")).toBe(false);
  });

  it("does not fire when after is undefined", () => {
    expect(isFirstGoingLive("scheduled", undefined)).toBe(false);
  });
});
