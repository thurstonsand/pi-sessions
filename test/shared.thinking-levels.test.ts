import { describe, expect, it } from "vitest";
import { isThinkingLevel, THINKING_LEVELS } from "../extensions/shared/thinking-levels.ts";

describe("thinking levels", () => {
  it("accepts every canonical level including max", () => {
    for (const level of THINKING_LEVELS) {
      expect(isThinkingLevel(level)).toBe(true);
    }
    expect(THINKING_LEVELS).toContain("max");
    expect(THINKING_LEVELS).toContain("off");
  });

  it("rejects unknown values and undefined", () => {
    expect(isThinkingLevel("maximum")).toBe(false);
    expect(isThinkingLevel("")).toBe(false);
    expect(isThinkingLevel(undefined)).toBe(false);
  });
});
