import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  formatModelArgument,
  formatModelList,
  resolveModelOverride,
} from "../extensions/session-handoff/model.ts";

const AVAILABLE = [model("openai", "gpt-5.4"), model("anthropic", "claude-sonnet-4-5")];

describe("handoff model resolution", () => {
  it("formats a model with a thinking level", () => {
    expect(formatModelArgument(AVAILABLE[0], "medium")).toBe("openai/gpt-5.4:medium");
  });

  it("formats a model without a thinking level", () => {
    expect(formatModelArgument(AVAILABLE[0], undefined)).toBe("openai/gpt-5.4");
  });

  it("returns undefined without a model", () => {
    expect(formatModelArgument(undefined, "high")).toBeUndefined();
  });

  it("lists available models as provider/id", () => {
    expect(formatModelList(AVAILABLE)).toBe("openai/gpt-5.4, anthropic/claude-sonnet-4-5");
  });

  it("resolves an exact provider/id override", () => {
    expect(resolveModelOverride(AVAILABLE, "anthropic/claude-sonnet-4-5")).toBe(AVAILABLE[1]);
  });

  it("throws with the available list on an unknown model", () => {
    expect(() => resolveModelOverride(AVAILABLE, "openai/ghost")).toThrow(
      'Unknown model "openai/ghost". Available models: openai/gpt-5.4, anthropic/claude-sonnet-4-5.',
    );
  });

  it("notes that thinking belongs in thinkingLevel when a colon form is passed", () => {
    expect(() => resolveModelOverride(AVAILABLE, "openai/gpt-5.4:medium")).toThrow(
      "Thinking level belongs in the thinkingLevel parameter, not the model id.",
    );
  });
});

function model(provider: string, id: string): Model<Api> {
  return { provider, id } as Model<Api>;
}
