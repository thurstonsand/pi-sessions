import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  formatModelArgument,
  resolveChildModel,
  resolveModelPattern,
} from "../extensions/session-handoff/model.ts";
import {
  buildHandoffRoster,
  formatRoster,
  type HandoffRoster,
  resolveHandoffRoster,
} from "../extensions/session-handoff/roster.ts";
import { formatModelSelection, parseModelSelection } from "../extensions/shared/model.ts";
import { createFakeModelRuntime } from "./test-helpers.ts";

const AVAILABLE = [model("openai", "gpt-5.4"), model("anthropic", "claude-sonnet-4-5")];

function runtime(options?: { all?: Model<Api>[] }) {
  return createFakeModelRuntime({
    available: AVAILABLE,
    ...(options?.all ? { all: options.all } : {}),
  }) as never;
}

describe("model selection round-trip", () => {
  it("formats a model with a thinking level", () => {
    expect(formatModelArgument(AVAILABLE[0], "medium")).toBe("openai/gpt-5.4:medium");
  });

  it("formats a model without a thinking level", () => {
    expect(formatModelArgument(AVAILABLE[0], undefined)).toBe("openai/gpt-5.4");
  });

  it("returns undefined without a model", () => {
    expect(formatModelArgument(undefined, "high")).toBeUndefined();
  });

  it("separates a thinking suffix from the model identity", () => {
    expect(parseModelSelection("openai/gpt-5.4:high")).toEqual({
      provider: "openai",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
    });
    expect(parseModelSelection("provider/model:release")).toEqual({
      provider: "provider",
      modelId: "model:release",
      thinkingLevel: undefined,
    });
  });

  it("rebuilds the string it parsed", () => {
    for (const value of ["openai/gpt-5.4", "openai/gpt-5.4:high", "provider/model:release"]) {
      expect(formatModelSelection(parseModelSelection(value))).toBe(value);
    }
  });

  it("refuses a reference without a provider", () => {
    expect(() => parseModelSelection("gpt-5.4")).toThrow(
      'Expected a "provider/model-id" reference; got "gpt-5.4".',
    );
    expect(() => parseModelSelection("/gpt-5.4")).toThrow('Expected a "provider/model-id"');
    expect(() => parseModelSelection("openai/")).toThrow('Expected a "provider/model-id"');
  });
});

describe("configured model pattern resolution", () => {
  it("resolves an exact provider/id pattern", () => {
    expect(resolveModelPattern(runtime(), "anthropic/claude-sonnet-4-5").model).toBe(AVAILABLE[1]);
  });

  it("resolves a thinking suffix on the pattern", () => {
    const override = resolveModelPattern(runtime(), "openai/gpt-5.4:medium");
    expect(override.model).toBe(AVAILABLE[0]);
    expect(override.thinkingLevel).toBe("medium");
  });

  it("prefers an explicit thinking level over the suffix", () => {
    expect(resolveModelPattern(runtime(), "openai/gpt-5.4:medium", "high").thinkingLevel).toBe(
      "high",
    );
  });

  it("resolves a fuzzy id fragment", () => {
    expect(resolveModelPattern(runtime(), "sonnet").model).toBe(AVAILABLE[1]);
  });

  it("throws with the available list on an unknown model", () => {
    expect(() => resolveModelPattern(runtime(), "ghost/model")).toThrow(
      "Available models: openai/gpt-5.4, anthropic/claude-sonnet-4-5.",
    );
  });

  it("rejects a model that resolves but is not authenticated", () => {
    const unauthenticated = model("google", "gemini-3.1-pro");
    expect(() =>
      resolveModelPattern(
        runtime({ all: [...AVAILABLE, unauthenticated] }),
        "google/gemini-3.1-pro",
      ),
    ).toThrow('Model "google/gemini-3.1-pro" is not an available authenticated model.');
  });
});

describe("handoff roster", () => {
  const METERED = model("metered", "claude-sonnet-4-5");
  const MODELS = [...AVAILABLE, METERED];

  function roster(...patterns: string[]): HandoffRoster | undefined {
    return buildHandoffRoster(MODELS, patterns.map(parseModelSelection));
  }

  it("expands globs against the authenticated models", () => {
    expect(roster("anthropic/*", "openai/gpt-5.4:high")).toEqual([
      { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevels: undefined },
      { provider: "openai", modelId: "gpt-5.4", thinkingLevels: ["high"] },
    ]);
  });

  it("is unrestricted when no patterns are configured", () => {
    expect(buildHandoffRoster(MODELS, [])).toBeUndefined();
  });

  it("drops patterns that match no authenticated model", () => {
    expect(roster("ghost/*")).toEqual([]);
  });

  it("unions the thinking levels of overlapping patterns", () => {
    expect(formatRoster(roster("openai/gpt-5.4:high", "*/gpt-5.4:low") ?? [])).toBe(
      "openai/gpt-5.4:{high,low}",
    );
  });

  it("widens to any level once a pattern omits one", () => {
    expect(formatRoster(roster("openai/gpt-5.4:high", "openai/*") ?? [])).toBe("openai/gpt-5.4");
  });

  it("refuses a model the roster leaves out", () => {
    expect(() =>
      resolveChildModel(
        runtime({ all: MODELS }),
        roster("anthropic/*"),
        { provider: "metered", modelId: "claude-sonnet-4-5" },
        undefined,
      ),
    ).toThrow(
      'Model "metered/claude-sonnet-4-5" is not on the handoff roster. Allowed models: anthropic/claude-sonnet-4-5.',
    );
  });

  it("applies a pinned thinking level", () => {
    const override = resolveChildModel(
      runtime(),
      roster("openai/gpt-5.4:high"),
      { provider: "openai", modelId: "gpt-5.4" },
      undefined,
    );
    expect(override.model).toBe(AVAILABLE[0]);
    expect(override.thinkingLevel).toBe("high");
  });

  it("lets the agent choose a level when the roster pins none", () => {
    const override = resolveChildModel(
      runtime(),
      roster("openai/gpt-5.4"),
      { provider: "openai", modelId: "gpt-5.4" },
      "low",
    );
    expect(override.thinkingLevel).toBe("low");
  });

  it("rejects a thinking level the roster leaves out", () => {
    expect(() =>
      resolveChildModel(
        runtime(),
        roster("openai/gpt-5.4:high"),
        { provider: "openai", modelId: "gpt-5.4" },
        "low",
      ),
    ).toThrow(
      'The handoff roster does not allow thinking level low for "openai/gpt-5.4"; allowed: high.',
    );
  });

  it("offers every listed level when a model is rostered more than once", () => {
    const both = roster("openai/gpt-5.4:low", "openai/gpt-5.4:high");
    const requested = { provider: "openai", modelId: "gpt-5.4" };
    expect(resolveChildModel(runtime(), both, requested, "low").thinkingLevel).toBe("low");
    expect(resolveChildModel(runtime(), both, requested, "high").thinkingLevel).toBe("high");
    expect(() => resolveChildModel(runtime(), both, requested, undefined)).toThrow(
      'The handoff roster requires a thinking level for "openai/gpt-5.4": one of low, high.',
    );
  });

  it("reports an empty roster as no override rather than unrestricted", () => {
    expect(() =>
      resolveChildModel(runtime(), [], { provider: "openai", modelId: "gpt-5.4" }, undefined),
    ).toThrow("sessions.handoff.roster matches no authenticated model");
  });

  it("prefers configured patterns, then scoped models, then nothing", () => {
    const scopedModels = [{ model: METERED, thinkingLevel: "low" as const }];
    const tiers = (patterns: string[], scoped: typeof scopedModels) =>
      resolveHandoffRoster({
        models: MODELS,
        patterns: patterns.map(parseModelSelection),
        scopedModels: scoped,
      });

    expect(formatRoster(tiers(["openai/*"], scopedModels) ?? [])).toBe("openai/gpt-5.4");
    expect(formatRoster(tiers([], scopedModels) ?? [])).toBe("metered/claude-sonnet-4-5:low");
    expect(tiers([], [])).toBeUndefined();
  });

  it("falls back to fuzzy resolution only when unrostered", () => {
    expect(
      resolveChildModel(runtime(), undefined, { provider: "openai", modelId: "gpt-5.4" }, undefined)
        .model,
    ).toBe(AVAILABLE[0]);
  });
});

function model(provider: string, id: string): Model<Api> {
  return { provider, id } as Model<Api>;
}
