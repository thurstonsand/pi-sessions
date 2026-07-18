import type { Api, Model } from "@earendil-works/pi-ai";
import { type ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

export type ModelRuntimeProvider = (modelRegistry: ModelRegistry) => Promise<ModelRuntime>;

// Workaround for a missing extension API: resolveCliModel and createAgentSession want a
// ModelRuntime, but ExtensionContext only exposes the ModelRegistry compatibility facade,
// which keeps its runtime private. Until pi exposes the runtime to extensions, build a
// fresh one per use and mirror the registered providers (e.g. pi-claude-bridge) so their
// configs — including live streamSimple closures — carry over by reference.
export async function createSessionModelRuntime(
  modelRegistry: ModelRegistry,
): Promise<ModelRuntime> {
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });

  for (const providerId of modelRegistry.getRegisteredProviderIds()) {
    const config = modelRegistry.getRegisteredProviderConfig(providerId);
    if (config) {
      modelRuntime.registerProvider(providerId, config);
    }
  }

  await modelRuntime.refresh({ allowNetwork: false });
  return modelRuntime;
}

// A model reference carried on the session context is stale relative to the mirrored runtime
// (it was resolved against the facade's private runtime, not this one). Re-resolve it against
// the runtime's snapshot so downstream calls use the mirror's live provider config, falling
// back to the original reference when the runtime has not seen it.
export function freshenModel(runtime: ModelRuntime, model: Model<Api>): Model<Api> {
  return runtime.getModel(model.provider, model.id) ?? model;
}
