import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, expectTypeOf, it } from "vitest";
import { getSessionModelRuntime } from "../extensions/shared/model-runtime.ts";

describe("getSessionModelRuntime", () => {
  // Fails when a Pi upgrade renames the private field the workaround reads.
  it("returns the runtime behind Pi's ModelRegistry facade", async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });

    expect(getSessionModelRuntime(new ModelRegistry(runtime))).toBe(runtime);
  });

  // Fails typecheck once Pi exposes the runtime (earendil-works/pi#8791). Switch callers to the
  // public API and delete shared/model-runtime.ts.
  it("tracks that extensions still lack a public model runtime", () => {
    expectTypeOf<ExtensionContext>().not.toHaveProperty("modelRuntime");
    expectTypeOf<ModelRegistry>().not.toHaveProperty("runtime");
  });
});
