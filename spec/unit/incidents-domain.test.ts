import { describe, expect, it } from "bun:test";
import { validateTransition } from "../../src/modules/incidents/domain.ts";

describe("incident state machine", () => {
  const valid = [
    ["open", "under_review"], ["under_review", "in_progress"],
    ["in_progress", "resolved"], ["open", "cancelled"],
    ["under_review", "cancelled"], ["in_progress", "cancelled"],
  ] as const;

  for (const [from, to] of valid) {
    it(`allows ${from} -> ${to}`, () => {
      expect(() => validateTransition(from, to, to === "cancelled" ? "Reason" : undefined, to === "resolved" ? "Fixed" : undefined)).not.toThrow();
    });
  }

  it("rejects final-state transitions", () => {
    expect(() => validateTransition("resolved", "open")).toThrow("Cannot transition");
    expect(() => validateTransition("cancelled", "open")).toThrow("Cannot transition");
  });
  it("requires cancellation observation and resolution solution", () => {
    expect(() => validateTransition("open", "cancelled")).toThrow("observation");
    expect(() => validateTransition("in_progress", "resolved")).toThrow("solution");
  });
});
