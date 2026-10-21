import { type ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

export type ModelRuntimeProvider = (modelRegistry: ModelRegistry) => ModelRuntime;

// Workaround for earendil-works/pi#8791: resolveCliModel and createAgentSession want the
// session's ModelRuntime, but ExtensionContext only exposes the ModelRegistry facade, which
// keeps its runtime in a private field. Building a fresh runtime and mirroring providers into
// it races Pi's own availability refreshes (earendil-works/pi#8810) and can report no
// available models, so read the session's runtime instead. test/shared.model-runtime.test.ts
// fails when Pi renames the field or exposes the runtime publicly; then delete this module.
export function getSessionModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
  const runtime: unknown = Reflect.get(modelRegistry, "runtime");
  if (!(runtime instanceof ModelRuntime)) {
    throw new Error(
      "pi-sessions cannot reach Pi's model runtime: ModelRegistry no longer keeps it in `runtime`.",
    );
  }
  return runtime;
}
