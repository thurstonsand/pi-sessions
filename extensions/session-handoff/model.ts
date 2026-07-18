import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { formatAvailableModelList, resolveAuthenticatedModel } from "../shared/model-resolution.ts";

export function formatModelArgument(
  model: Model<Api> | undefined,
  thinkingLevel: ThinkingLevel | undefined,
): string | undefined {
  if (!model) {
    return undefined;
  }

  const base = `${model.provider}/${model.id}`;
  return thinkingLevel ? `${base}:${thinkingLevel}` : base;
}

export interface HandoffModelOverride {
  model: Model<Api>;
  thinkingLevel: ThinkingLevel | undefined;
}

export function resolveModelOverride(
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
