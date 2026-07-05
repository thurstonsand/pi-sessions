import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findModelByReference } from "../shared/model.ts";
import { ModelReference } from "../shared/settings.ts";

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
    const configuredMatch = findModelByReference(availableModels, configuredModel);
    if (configuredMatch) {
      return {
        model: configuredMatch,
        source: "configured",
      };
    }
  }

  for (const fallbackReference of DEFAULT_AUTO_TITLE_FALLBACK_MODELS) {
    const fallbackMatch = findModelByReference(availableModels, fallbackReference);
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
