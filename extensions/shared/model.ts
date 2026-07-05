import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelReference } from "./settings.ts";

export function findModelByReference(
  availableModels: Model<Api>[],
  reference: ModelReference,
): Model<Api> | undefined {
  return availableModels.find(
    (model) => model.provider === reference.provider && model.id === reference.modelId,
  );
}

export function resolveConfiguredModel(
  availableModels: Model<Api>[],
  configuredModel: ModelReference | undefined,
): Model<Api> | undefined {
  return configuredModel ? findModelByReference(availableModels, configuredModel) : undefined;
}
