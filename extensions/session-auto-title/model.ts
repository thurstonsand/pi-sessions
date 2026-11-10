import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type ExactModelReference, findModelByReference } from "../shared/model.ts";
import { resolveAuthenticatedModel } from "../shared/model-resolution.ts";

const DEFAULT_AUTO_TITLE_FALLBACK_MODELS: readonly ExactModelReference[] = [
  { provider: "openai-codex", modelId: "gpt-5.6-luna" },
  { provider: "openai", modelId: "gpt-5.6-luna" },
  { provider: "anthropic", modelId: "claude-haiku-4-5" },
  { provider: "google", modelId: "gemini-flash-lite-latest" },
] as const;

/**
 * Settings words that name the session's own model instead of a catalog model.
 * Pi hands the extension the session's current model, so this follows a model switch too.
 */
const SESSION_MODEL_PATTERNS: readonly string[] = ["current", "session", "default"];

function namesSessionModel(modelPattern: string): boolean {
  return SESSION_MODEL_PATTERNS.includes(modelPattern.trim().toLowerCase());
}

export type AutoTitleModelSource = "configured" | "fallback" | "current";

export interface AutoTitleModelResolution {
  model: Model<Api>;
  source: AutoTitleModelSource;
  thinkingLevel?: ThinkingLevel | undefined;
}

/**
 * Pick the model that writes a session title.
 *
 * The `sessions.autoTitle.model` setting wins when it names an available model, where
 * `current`, `session` and `default` name the session's own model. Otherwise the internal
 * fallback list is tried in order, and the session's model serves as the last resort.
 * Returns undefined when nothing resolves.
 */
export function resolveAutoTitleModel(
  modelRuntime: ModelRuntime,
  currentModel: Model<Api> | undefined,
  configuredModel: string | undefined,
): AutoTitleModelResolution | undefined {
  const sessionModelRequested = configuredModel !== undefined && namesSessionModel(configuredModel);

  if (configuredModel && !sessionModelRequested) {
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

  if (sessionModelRequested && currentModel) {
    return {
      model: currentModel,
      source: "current",
    };
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
    model: currentModel,
    source: "current",
  };
}
