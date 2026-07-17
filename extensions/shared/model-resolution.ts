import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelsAreEqual } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveCliModel } from "@earendil-works/pi-coding-agent";

export type AuthenticatedModelResolution =
  | {
      ok: true;
      model: Model<Api>;
      thinkingLevel: ThinkingLevel | undefined;
      warning: string | undefined;
    }
  | {
      ok: false;
      error: string;
      warning: string | undefined;
    };

/**
 * Resolves a model pattern with Pi's CLI grammar (fuzzy aliases, slash ids,
 * `:thinking` suffixes), then narrows the result to a fresh entry from
 * `getAvailable()`. resolveCliModel intentionally searches getAll() for CLI
 * setup flows; nested extension work must only run activated, authenticated
 * models, and the available object is the one that crosses that boundary.
 */
export function resolveAuthenticatedModel(options: {
  modelRegistry: ModelRegistry;
  modelPattern: string;
  thinkingLevel?: ThinkingLevel | undefined;
}): AuthenticatedModelResolution {
  const resolved = resolveCliModel({
    cliModel: options.modelPattern,
    ...(options.thinkingLevel ? { cliThinking: options.thinkingLevel } : {}),
    modelRegistry: options.modelRegistry,
  });

  if (resolved.error || !resolved.model) {
    return {
      ok: false,
      error: stripCliGuidance(resolved.error) ?? `Unknown model "${options.modelPattern}".`,
      warning: resolved.warning,
    };
  }

  const available = options.modelRegistry
    .getAvailable()
    .find((model) => modelsAreEqual(model, resolved.model));
  if (!available) {
    return {
      ok: false,
      error: `Model "${resolved.model.provider}/${resolved.model.id}" is not an available authenticated model.`,
      warning: resolved.warning,
    };
  }

  return {
    ok: true,
    model: available,
    thinkingLevel: options.thinkingLevel ?? resolved.thinkingLevel,
    warning: resolved.warning,
  };
}

// resolveCliModel errors reference --list-models, which does not exist in extension surfaces.
function stripCliGuidance(error: string | undefined): string | undefined {
  const stripped = error?.replace(/(?:^|\s+)[^.!?\n]*--list-models[^.!?\n]*(?:[.!?]|$)/, "").trim();
  return stripped || undefined;
}

export function formatAvailableModelList(models: readonly Model<Api>[]): string {
  return models.map((model) => `${model.provider}/${model.id}`).join(", ");
}
