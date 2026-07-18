import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { formatModelArgument, resolveModelOverride } from "../extensions/session-handoff/model.ts";
import { createFakeModelRuntime } from "./test-helpers.ts";

const AVAILABLE = [model("openai", "gpt-5.4"), model("anthropic", "claude-sonnet-4-5")];

function runtime(options?: { all?: Model<Api>[] }) {
  return createFakeModelRuntime({
    available: AVAILABLE,
    ...(options?.all ? { all: options.all } : {}),
  }) as never;
}

describe("handoff model resolution", () => {
  it("formats a model with a thinking level", () => {
    expect(formatModelArgument(AVAILABLE[0], "medium")).toBe("openai/gpt-5.4:medium");
  });

  it("formats a model without a thinking level", () => {
    expect(formatModelArgument(AVAILABLE[0], undefined)).toBe("openai/gpt-5.4");
  });

  it("returns undefined without a model", () => {
    expect(formatModelArgument(undefined, "high")).toBeUndefined();
  });

  it("resolves an exact provider/id override", () => {
    expect(resolveModelOverride(runtime(), "anthropic/claude-sonnet-4-5").model).toBe(AVAILABLE[1]);
  });

  it("resolves a thinking suffix on the override", () => {
    const override = resolveModelOverride(runtime(), "openai/gpt-5.4:medium");
    expect(override.model).toBe(AVAILABLE[0]);
    expect(override.thinkingLevel).toBe("medium");
  });

  it("prefers an explicit thinking level over the suffix", () => {
    const override = resolveModelOverride(runtime(), "openai/gpt-5.4:medium", "high");
    expect(override.thinkingLevel).toBe("high");
  });

  it("resolves a fuzzy id fragment", () => {
    expect(resolveModelOverride(runtime(), "sonnet").model).toBe(AVAILABLE[1]);
  });

  it("throws with the available list on an unknown model", () => {
    expect(() => resolveModelOverride(runtime(), "ghost/model")).toThrow(
      "Available models: openai/gpt-5.4, anthropic/claude-sonnet-4-5.",
    );
  });

  it("rejects a model that resolves but is not authenticated", () => {
    const unauthenticated = model("google", "gemini-3.1-pro");
    expect(() =>
      resolveModelOverride(
        runtime({ all: [...AVAILABLE, unauthenticated] }),
        "google/gemini-3.1-pro",
      ),
    ).toThrow('Model "google/gemini-3.1-pro" is not an available authenticated model.');
  });
});

function model(provider: string, id: string): Model<Api> {
  return { provider, id } as Model<Api>;
}
