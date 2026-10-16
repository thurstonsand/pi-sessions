import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveAuthenticatedModel } from "../extensions/shared/model-resolution.ts";
import { createFakeModelRuntime } from "./test-helpers.ts";

const SLASH_ID = model("openrouter", "moonshotai/kimi-k2.6");
const AVAILABLE = [model("openai", "gpt-5.4"), model("anthropic", "claude-sonnet-4-5"), SLASH_ID];

function resolve(pattern: string, options?: { all?: Model<Api>[]; thinkingLevel?: "high" }) {
  return resolveAuthenticatedModel({
    modelRuntime: createFakeModelRuntime({
      available: AVAILABLE,
      ...(options?.all ? { all: options.all } : {}),
    }) as never,
    modelPattern: pattern,
    thinkingLevel: options?.thinkingLevel,
  });
}

describe("resolveAuthenticatedModel", () => {
  it("resolves canonical provider/id patterns", () => {
    const result = resolve("openai/gpt-5.4");
    expect(result).toMatchObject({ ok: true, model: AVAILABLE[0] });
  });

  it("resolves model ids that contain slashes", () => {
    const result = resolve("moonshotai/kimi-k2.6");
    expect(result).toMatchObject({ ok: true, model: SLASH_ID });
  });

  it("resolves fuzzy fragments against available models", () => {
    const result = resolve("sonnet");
    expect(result).toMatchObject({ ok: true, model: AVAILABLE[1] });
  });

  it("parses a thinking suffix", () => {
    const result = resolve("anthropic/claude-sonnet-4-5:xhigh");
    expect(result).toMatchObject({ ok: true, model: AVAILABLE[1], thinkingLevel: "xhigh" });
  });

  it("lets an explicit thinking level win over the suffix", () => {
    const result = resolve("anthropic/claude-sonnet-4-5:low", { thinkingLevel: "high" });
    expect(result).toMatchObject({ ok: true, thinkingLevel: "high" });
  });

  it("errors on unknown patterns", () => {
    const result = resolve("ghost/model");
    expect(result.ok).toBe(false);
  });

  it("names the candidates when authenticated providers share a model, without CLI flags", () => {
    const metered = model("metered", "gpt-5.4");
    const result = resolveAuthenticatedModel({
      modelRuntime: createFakeModelRuntime({ available: [...AVAILABLE, metered] }) as never,
      modelPattern: "gpt-5.4",
    });
    expect(result).toEqual({
      ok: false,
      error:
        'Model "gpt-5.4" is ambiguous across providers: metered/gpt-5.4, openai/gpt-5.4. Use provider/model.',
      warning: undefined,
    });
  });

  it("resolves a shared model id to the only authenticated provider", () => {
    const unauthenticated = model("metered", "gpt-5.4");
    const result = resolve("gpt-5.4", { all: [...AVAILABLE, unauthenticated] });
    expect(result).toMatchObject({ ok: true, model: AVAILABLE[0] });
  });

  it("rejects models that only exist in getAll()", () => {
    const unauthenticated = model("google", "gemini-3.1-pro");
    const result = resolve("google/gemini-3.1-pro", { all: [...AVAILABLE, unauthenticated] });
    expect(result).toMatchObject({
      ok: false,
      error: 'Model "google/gemini-3.1-pro" is not an available authenticated model.',
    });
  });
});

function model(provider: string, id: string): Model<Api> {
  return { provider, id } as Model<Api>;
}
