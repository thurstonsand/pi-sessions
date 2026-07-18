import { type ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionModelRuntime } from "../extensions/shared/model-runtime.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSessionModelRuntime", () => {
  it("mirrors the registered provider stream used by pi-claude-bridge", async () => {
    const streamSimple = vi.fn();
    const providerConfig = {
      apiKey: "claude-agent-sdk",
      models: [{ provider: "anthropic", id: "claude-sonnet" }],
      streamSimple,
    };
    const modelRegistry = {
      getRegisteredProviderIds: () => ["anthropic"],
      getRegisteredProviderConfig: () => providerConfig,
    } as unknown as ModelRegistry;
    const registerProvider = vi.fn();
    const refresh = vi.fn().mockResolvedValue({ aborted: false, errors: new Map() });
    const modelRuntime = {
      registerProvider,
      refresh,
    } as unknown as ModelRuntime;
    vi.spyOn(ModelRuntime, "create").mockResolvedValue(modelRuntime);

    const created = await createSessionModelRuntime(modelRegistry);

    expect(created).toBe(modelRuntime);
    expect(ModelRuntime.create).toHaveBeenCalledWith({ allowModelNetwork: false });
    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider).toHaveBeenCalledWith("anthropic", providerConfig);
    expect(registerProvider.mock.calls[0]?.[1].streamSimple).toBe(streamSimple);
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: false });
  });

  it("mirrors the current registrations on each call", async () => {
    const registeredConfigs = new Map([["anthropic", { apiKey: "first" }]]);
    const modelRegistry = {
      getRegisteredProviderIds: () => [...registeredConfigs.keys()],
      getRegisteredProviderConfig: (providerId: string) => registeredConfigs.get(providerId),
    } as unknown as ModelRegistry;
    const registerProvider = vi.fn();
    const modelRuntime = {
      registerProvider,
      refresh: vi.fn().mockResolvedValue({ aborted: false, errors: new Map() }),
    } as unknown as ModelRuntime;
    vi.spyOn(ModelRuntime, "create").mockResolvedValue(modelRuntime);

    await createSessionModelRuntime(modelRegistry);
    const replacement = { apiKey: "second" };
    registeredConfigs.set("anthropic", replacement);
    await createSessionModelRuntime(modelRegistry);

    expect(registerProvider).toHaveBeenCalledTimes(2);
    expect(registerProvider).toHaveBeenLastCalledWith("anthropic", replacement);
  });
});
