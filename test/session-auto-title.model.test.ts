import { describe, expect, it } from "vitest";
import { resolveAutoTitleModel } from "../extensions/session-auto-title/model.js";
import { ModelReference } from "../extensions/shared/settings.js";

interface TestModel {
  provider: string;
  id: string;
}

function createModel(provider: string, id: string): TestModel {
  return { provider, id };
}

function createContext(options?: { currentModel?: TestModel; availableModels?: TestModel[] }) {
  const state = {
    currentModel: options?.currentModel,
    availableModels: options?.availableModels ?? [],
  };

  return {
    model: state.currentModel,
    modelRegistry: {
      getAvailable() {
        return state.availableModels;
      },
    },
  } as never;
}

describe("session auto-title model resolution", () => {
  it("prefers an available configured model", () => {
    const configuredModel = createModel("openai", "gpt-5.4-mini");
    const fallbackModel = createModel("google", "gemini-flash-lite-latest");
    const ctx = createContext({
      availableModels: [fallbackModel, configuredModel],
    });

    expect(resolveAutoTitleModel(ctx, new ModelReference("openai", "gpt-5.4-mini"))).toEqual({
      model: configuredModel,
      source: "configured",
    });
  });

  it("walks the internal fallback list in order when the configured model is unavailable", () => {
    const anthropicModel = createModel("anthropic", "claude-haiku-4-5");
    const openAiModel = createModel("openai", "gpt-5.4-mini");
    const ctx = createContext({
      availableModels: [openAiModel, anthropicModel],
    });

    expect(
      resolveAutoTitleModel(ctx, new ModelReference("google", "gemini-flash-lite-latest")),
    ).toEqual({
      model: anthropicModel,
      source: "fallback",
    });
  });

  it("falls back to the current session model when no configured or internal fallback candidate is available", () => {
    const currentModel = createModel("openai", "gpt-4.1");
    const ctx = createContext({ currentModel });

    expect(resolveAutoTitleModel(ctx, undefined)).toEqual({
      model: currentModel,
      source: "current",
    });
  });

  it("returns undefined when no model can be resolved", () => {
    const ctx = createContext();

    expect(resolveAutoTitleModel(ctx, undefined)).toBeUndefined();
  });
});
