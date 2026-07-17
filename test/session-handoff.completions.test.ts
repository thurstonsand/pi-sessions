import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { getHandoffModelCompletions } from "../extensions/session-handoff/completions.ts";

const MODELS = [
  model("openai", "gpt-5.4"),
  model("openai", "gpt-5.4-mini"),
  model("anthropic", "claude-sonnet-4-5"),
];

describe("handoff model completions", () => {
  it("returns null when the text is not in a --model value position", () => {
    expect(getHandoffModelCompletions("Finish phase 1", MODELS)).toBeNull();
    expect(getHandoffModelCompletions("--deferred Finish", MODELS)).toBeNull();
    expect(getHandoffModelCompletions("--model", MODELS)).toBeNull();
  });

  it("offers every model right after --model", () => {
    const items = getHandoffModelCompletions("--right --model ", MODELS);
    expect(items?.map((item) => item.value)).toEqual([
      "--right --model openai/gpt-5.4",
      "--right --model openai/gpt-5.4-mini",
      "--right --model anthropic/claude-sonnet-4-5",
    ]);
    expect(items?.[0]).toMatchObject({ label: "gpt-5.4", description: "openai" });
  });

  it("filters by the partial and replaces the whole argument text", () => {
    const items = getHandoffModelCompletions("Ship it --model gpt-5.4-mi", MODELS);
    expect(items).toEqual([
      {
        value: "Ship it --model openai/gpt-5.4-mini",
        label: "gpt-5.4-mini",
        description: "openai",
      },
    ]);
  });

  it("matches on provider as well as id", () => {
    const items = getHandoffModelCompletions("--model anthro", MODELS);
    expect(items?.map((item) => item.value)).toEqual(["--model anthropic/claude-sonnet-4-5"]);
  });

  it("returns null when nothing matches or the snapshot is empty", () => {
    expect(getHandoffModelCompletions("--model zzz", MODELS)).toBeNull();
    expect(getHandoffModelCompletions("--model ", [])).toBeNull();
  });
});

function model(provider: string, id: string): Model<Api> {
  return { provider, id } as Model<Api>;
}
