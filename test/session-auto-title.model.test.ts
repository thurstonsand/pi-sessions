import { describe, expect, it } from "vitest";
import { resolveAutoTitleModel } from "../extensions/session-auto-title/model.ts";
import { createFakeModelRuntime } from "./test-helpers.ts";

interface TestModel {
  provider: string;
  id: string;
}

function createModel(provider: string, id: string): TestModel {
  return { provider, id };
}

function resolveModel(
  options: { currentModel?: TestModel; availableModels?: TestModel[] },
  configuredModel: string | undefined,
) {
  return resolveAutoTitleModel(
    createFakeModelRuntime({ available: options.availableModels ?? [] }) as never,
    options.currentModel as never,
    configuredModel,
  );
}

describe("session auto-title model resolution", () => {
  it("prefers an available configured model", () => {
    const configuredModel = createModel("openai", "gpt-5.4-mini");
    const fallbackModel = createModel("google", "gemini-flash-lite-latest");

    expect(
      resolveModel({ availableModels: [fallbackModel, configuredModel] }, "openai/gpt-5.4-mini"),
    ).toMatchObject({
      model: configuredModel,
      source: "configured",
    });
  });

  it("carries a thinking suffix from the configured model pattern", () => {
    const configuredModel = createModel("openai", "gpt-5.4-mini");

    expect(
      resolveModel({ availableModels: [configuredModel] }, "openai/gpt-5.4-mini:low"),
    ).toMatchObject({
      model: configuredModel,
      source: "configured",
      thinkingLevel: "low",
    });
  });

  it("prefers the first available internal fallback", () => {
    const lunaModel = createModel("openai-codex", "gpt-5.6-luna");
    const anthropicModel = createModel("anthropic", "claude-haiku-4-5");

    expect(resolveModel({ availableModels: [anthropicModel, lunaModel] }, undefined)).toMatchObject(
      {
        model: lunaModel,
        source: "fallback",
      },
    );
  });

  it("accepts Luna from the openai provider when the Codex variant is unavailable", () => {
    const lunaModel = createModel("openai", "gpt-5.6-luna");
    const anthropicModel = createModel("anthropic", "claude-haiku-4-5");

    expect(resolveModel({ availableModels: [anthropicModel, lunaModel] }, undefined)).toMatchObject(
      {
        model: lunaModel,
        source: "fallback",
      },
    );
  });

  it("walks the internal fallback list when both Luna providers are unavailable", () => {
    const anthropicModel = createModel("anthropic", "claude-haiku-4-5");

    expect(
      resolveModel({ availableModels: [anthropicModel] }, "google/gemini-flash-lite-latest"),
    ).toMatchObject({
      model: anthropicModel,
      source: "fallback",
    });
  });

  it("falls back to the current session model when no configured or internal fallback candidate is available", () => {
    const currentModel = createModel("openai", "gpt-4.1");

    expect(resolveModel({ currentModel }, undefined)).toMatchObject({
      model: currentModel,
      source: "current",
    });
  });

  it("returns undefined when no model can be resolved", () => {
    expect(resolveModel({}, undefined)).toBeUndefined();
  });
});
