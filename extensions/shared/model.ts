import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isThinkingLevel } from "./thinking-levels.ts";

export interface ExactModelReference {
  provider: string;
  modelId: string;
}

/**
 * The structured representation of "which model, at which thinking level". Pi's
 * CLI grammar spells this `provider/model-id[:level]`; that string is an edge
 * format, parsed on the way in and rebuilt on the way out.
 */
export interface ModelSelection extends ExactModelReference {
  thinkingLevel: ThinkingLevel | undefined;
}

export function parseModelSelection(value: string): ModelSelection {
  const separator = value.lastIndexOf(":");
  const suffix = separator >= 0 ? value.slice(separator + 1) : undefined;
  const thinkingLevel = isThinkingLevel(suffix) ? suffix : undefined;
  const reference = thinkingLevel ? value.slice(0, separator) : value;

  const boundary = reference.indexOf("/");
  if (boundary <= 0 || boundary === reference.length - 1) {
    throw new Error(`Expected a "provider/model-id" reference; got "${value}".`);
  }

  return {
    provider: reference.slice(0, boundary),
    modelId: reference.slice(boundary + 1),
    thinkingLevel,
  };
}

export function formatModelSelection(selection: ModelSelection): string {
  const reference = `${selection.provider}/${selection.modelId}`;
  return selection.thinkingLevel ? `${reference}:${selection.thinkingLevel}` : reference;
}

export function selectModel(
  model: Model<Api>,
  thinkingLevel: ThinkingLevel | undefined,
): ModelSelection {
  return { provider: model.provider, modelId: model.id, thinkingLevel };
}

export function findModelByReference(
  availableModels: readonly Model<Api>[],
  reference: ExactModelReference,
): Model<Api> | undefined {
  return availableModels.find(
    (model) => model.provider === reference.provider && model.id === reference.modelId,
  );
}
