import { describe, expect, it } from "vitest";
import { HANDOFF_TOOL_DETAILS_SCHEMA } from "../extensions/session-handoff/tool-contract.ts";
import { buildHandoffToolView } from "../extensions/session-handoff/tool-view-model.ts";
import { safeParseTypeBoxValue } from "../extensions/shared/typebox.ts";

describe("handoff-tool view model", () => {
  it("requires complete durable result details", () => {
    expect(
      safeParseTypeBoxValue(HANDOFF_TOOL_DETAILS_SCHEMA, {
        sessionId: "child-1",
        title: "Review rendering",
        launch: "deferred",
        childSessionFile: "/tmp/child-1.jsonl",
        resumeCommand: "pi --session-id child-1",
        model: "openai/gpt-5.4:high",
      }),
    ).toBeDefined();
    expect(
      safeParseTypeBoxValue(HANDOFF_TOOL_DETAILS_SCHEMA, {
        sessionId: "child-1",
        launch: "deferred",
      }),
    ).toBeUndefined();
  });

  it("normalizes progressive arguments without presentation concerns", () => {
    expect(
      buildHandoffToolView({
        launch: " deferred ",
        title: " Review rendering ",
        goal: " Inspect the renderer. ",
        provider: " openai ",
        model: " gpt-5.4 ",
        thinkingLevel: " high ",
      }),
    ).toEqual({
      launch: "deferred",
      title: "Review rendering",
      goal: "Inspect the renderer.",
      provider: "openai",
      model: "gpt-5.4",
      thinkingLevel: "high",
    });
  });

  it("uses durable result identity when streamed labels are missing", () => {
    const result = {
      sessionId: "child-1",
      title: "Review rendering",
      launch: "deferred" as const,
      childSessionFile: "/tmp/child-1.jsonl",
      resumeCommand: "pi --session-id child-1",
      model: "openai/gpt-5.4:high",
      provider: "openai",
      modelName: "GPT 5.4",
      thinkingLevel: "high" as const,
    };

    expect(buildHandoffToolView({}, result)).toEqual({
      launch: "deferred",
      title: "Review rendering",
      provider: "openai",
      model: "GPT 5.4",
      thinkingLevel: "high",
      result,
    });
  });
});
