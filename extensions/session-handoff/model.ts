import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { formatAvailableModelList, resolveAuthenticatedModel } from "../shared/model-resolution.ts";
import { isThinkingLevel } from "../shared/thinking-levels.ts";

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

export function parseModelArgument(value: string): {
  model: string;
  thinkingLevel?: ThinkingLevel | undefined;
} {
  const separator = value.lastIndexOf(":");
  const suffix = separator >= 0 ? value.slice(separator + 1) : undefined;
  if (!isThinkingLevel(suffix)) {
    return { model: value };
  }
  return {
    model: value.slice(0, separator),
    thinkingLevel: suffix,
  };
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
