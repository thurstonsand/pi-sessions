import { describe, expect, it } from "vitest";
import { buildLaunchReceipt } from "../extensions/session-handoff/receipt.ts";

describe("handoff launch receipt", () => {
  it("omits matching cwd while retaining the effective model", () => {
    const receipt = buildLaunchReceipt({
      sessionId: "child-1",
      childSessionFile: "/tmp/child-1.jsonl",
      title: "Index fix",
      launch: "deferred",
      resumeCommand: "pi --session-id 'child-1'",
      targetCwd: "/repo/app",
      parentCwd: "/repo/app",
      childModel: "openai/gpt-5.4:high",
      childProvider: "openai",
      childModelName: "GPT 5.4",
      thinkingLevel: "high",
    });

    expect(receipt).toEqual({
      sessionId: "child-1",
      childSessionFile: "/tmp/child-1.jsonl",
      title: "Index fix",
      launch: "deferred",
      resumeCommand: "pi --session-id 'child-1'",
      model: "openai/gpt-5.4:high",
      provider: "openai",
      modelName: "GPT 5.4",
      thinkingLevel: "high",
    });
  });

  it("includes a differing cwd and the effective model", () => {
    const receipt = buildLaunchReceipt({
      sessionId: "child-1",
      childSessionFile: "/tmp/child-1.jsonl",
      title: "Index fix",
      launch: "right",
      backend: "Ghostty",
      resumeCommand: "cd '/other' && pi --session-id 'child-1'",
      targetCwd: "/other",
      parentCwd: "/repo/app",
      childModel: "anthropic/claude-sonnet-4-5",
      childProvider: "anthropic",
      childModelName: "Claude Sonnet 4.5",
    });

    expect(receipt).toMatchObject({
      cwd: "/other",
      model: "anthropic/claude-sonnet-4-5",
      provider: "anthropic",
      modelName: "Claude Sonnet 4.5",
      backend: "Ghostty",
    });
  });
});
