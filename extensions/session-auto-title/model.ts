import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type ExactModelReference, findModelByReference } from "../shared/model.ts";
import { resolveAuthenticatedModel } from "../shared/model-resolution.ts";
import { freshenModel } from "../shared/model-runtime.ts";

const DEFAULT_AUTO_TITLE_FALLBACK_MODELS: readonly ExactModelReference[] = [
  { provider: "openai-codex", modelId: "gpt-5.6-luna" },
  { provider: "openai", modelId: "gpt-5.6-luna" },
  { provider: "anthropic", modelId: "claude-haiku-4-5" },
  { provider: "google", modelId: "gemini-flash-lite-latest" },
] as const;

export type AutoTitleModelSource = "configured" | "fallback" | "current";

export interface AutoTitleModelResolution {
  model: Model<Api>;
  source: AutoTitleModelSource;
  thinkingLevel?: ThinkingLevel | undefined;
}

export function resolveAutoTitleModel(
  modelRuntime: ModelRuntime,
  currentModel: Model<Api> | undefined,
  configuredModel: string | undefined,
): AutoTitleModelResolution | undefined {
  if (configuredModel) {
    const configured = resolveAuthenticatedModel({
      modelRuntime,
      modelPattern: configuredModel,
    });
    if (configured.ok) {
      return {
        model: configured.model,
        source: "configured",
        thinkingLevel: configured.thinkingLevel,
      };
    }
  }

  const availableModels = modelRuntime.getAvailableSnapshot();
  for (const fallbackReference of DEFAULT_AUTO_TITLE_FALLBACK_MODELS) {
    const fallbackMatch = findModelByReference(availableModels, fallbackReference);
    if (fallbackMatch) {
      return {
        model: fallbackMatch,
        source: "fallback",
      };
    }
  }

  if (!currentModel) {
    return undefined;
  }

  return {
    model: freshenModel(modelRuntime, currentModel),
    source: "current",
  };
}
