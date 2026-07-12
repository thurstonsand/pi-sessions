import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

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

export function formatModelList(models: readonly Model<Api>[]): string {
  return models.map((model) => `${model.provider}/${model.id}`).join(", ");
}

export function resolveModelOverride(
  availableModels: readonly Model<Api>[],
  reference: string,
): Model<Api> {
  const match = availableModels.find((model) => `${model.provider}/${model.id}` === reference);
  if (match) {
    return match;
  }

  const hint = reference.includes(":")
    ? " Thinking level belongs in the thinkingLevel parameter, not the model id."
    : "";
  throw new Error(
    `Unknown model "${reference}".${hint} Available models: ${formatModelList(availableModels)}.`,
  );
}
