import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type ExactModelReference,
  findModelByReference,
  formatModelSelection,
  selectModel,
} from "../shared/model.ts";
import { formatAvailableModelList, resolveAuthenticatedModel } from "../shared/model-resolution.ts";
import { type HandoffRoster, selectFromRoster } from "./roster.ts";

export function formatModelArgument(
  model: Model<Api> | undefined,
  thinkingLevel: ThinkingLevel | undefined,
): string | undefined {
  return model ? formatModelSelection(selectModel(model, thinkingLevel)) : undefined;
}

export interface HandoffModelOverride {
  model: Model<Api>;
  thinkingLevel: ThinkingLevel | undefined;
}

/**
 * Resolves the model a handoff launches its child on. A roster replaces Pi's CLI
 * matching entirely: fuzzy aliases resolve across every authenticated provider,
 * which is how delegated work lands on a metered provider that happens to serve
 * the same model id, so a rostered handoff accepts only an exact roster entry.
 */
export function resolveChildModel(
  modelRuntime: ModelRuntime,
  roster: HandoffRoster | undefined,
  requested: ExactModelReference,
  thinkingLevel: ThinkingLevel | undefined,
): HandoffModelOverride {
  if (!roster) {
    return resolveModelPattern(
      modelRuntime,
      formatModelSelection({ ...requested, thinkingLevel: undefined }),
      thinkingLevel,
    );
  }

  const level = selectFromRoster(roster, requested, thinkingLevel);
  const model = findModelByReference(modelRuntime.getAvailableSnapshot(), requested);
  if (!model) {
    throw new Error(
      `Model "${requested.provider}/${requested.modelId}" is no longer an available authenticated model.`,
    );
  }
  return { model, thinkingLevel: level };
}

/**
 * Resolves a user-configured model pattern with Pi's CLI grammar, including fuzzy
 * aliases. Only for settings the user writes by hand; never for a model's choice.
 */
export function resolveModelPattern(
  modelRuntime: ModelRuntime,
  modelPattern: string,
  thinkingLevel?: ThinkingLevel | undefined,
): HandoffModelOverride {
  const resolution = resolveAuthenticatedModel({ modelRuntime, modelPattern, thinkingLevel });
  if (!resolution.ok) {
    const warning = resolution.warning ? ` ${resolution.warning}` : "";
    throw new Error(
      `${resolution.error}${warning} Available models: ${formatAvailableModelList(
        modelRuntime.getAvailableSnapshot(),
      )}.`,
    );
  }

  return {
    model: resolution.model,
    thinkingLevel: resolution.thinkingLevel,
  };
}
