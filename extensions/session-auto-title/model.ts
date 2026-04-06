import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ModelReference } from "../shared/settings.js";

const DEFAULT_AUTO_TITLE_FALLBACK_MODELS: readonly ModelReference[] = [
  new ModelReference("google", "gemini-flash-lite-latest"),
  new ModelReference("anthropic", "claude-haiku-4-5"),
  new ModelReference("openai", "gpt-5.4-mini"),
] as const;

export type AutoTitleModelSource = "configured" | "fallback" | "current";

export interface AutoTitleModelResolution {
  model: Model<Api>;
  source: AutoTitleModelSource;
}

export function resolveAutoTitleModel(
  ctx: ExtensionContext,
  configuredModel: ModelReference | undefined,
): AutoTitleModelResolution | undefined {
  const availableModels = ctx.modelRegistry.getAvailable();

  if (configuredModel) {
    const configuredMatch = findMatchingModel(availableModels, configuredModel);
    if (configuredMatch) {
      return {
        model: configuredMatch,
        source: "configured",
      };
    }
  }

  for (const fallbackReference of DEFAULT_AUTO_TITLE_FALLBACK_MODELS) {
    const fallbackMatch = findMatchingModel(availableModels, fallbackReference);
    if (fallbackMatch) {
      return {
        model: fallbackMatch,
        source: "fallback",
      };
    }
  }

  if (!ctx.model) {
    return undefined;
  }

  return {
    model: ctx.model,
    source: "current",
  };
}

function findMatchingModel(
  availableModels: Model<Api>[],
  reference: ModelReference,
): Model<Api> | undefined {
  return availableModels.find(
    (model) => model.provider === reference.provider && model.id === reference.modelId,
  );
}
