import type { Api, Model } from "@earendil-works/pi-ai";

export interface ExactModelReference {
  provider: string;
  modelId: string;
}

export function findModelByReference(
  availableModels: readonly Model<Api>[],
  reference: ExactModelReference,
): Model<Api> | undefined {
  return availableModels.find(
    (model) => model.provider === reference.provider && model.id === reference.modelId,
  );
}
