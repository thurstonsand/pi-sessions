import { describe, expect, it } from "vitest";
import { buildHandoffToolPresentation } from "../extensions/session-handoff/tool-presenter.ts";

const theme = {
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
};

describe("handoff-tool presenter", () => {
  it("maps result metadata into generic expandable content", () => {
    expect(
      buildHandoffToolPresentation(
        {
          launch: "deferred",
          title: "Review rendering",
          goal: "Inspect the renderer.",
          provider: "openai",
          model: "GPT 5.4",
          thinkingLevel: "high",
          result: {
            sessionId: "child-1",
            title: "Review rendering",
            launch: "deferred",
            childSessionFile: "/tmp/child-1.jsonl",
            resumeCommand: "pi --session-id child-1",
            model: "openai/gpt-5.4:high",
            modelName: "GPT 5.4",
            thinkingLevel: "high",
            cwd: "/repo/app",
          },
        },
        theme,
      ),
    ).toEqual({
      header: "session_handoff [deferred] Review rendering",
      metadata: ["provider openai  ·  model GPT 5.4  ·  thinking high"],
      expandedMetadata: ["session child-1", "cwd /repo/app"],
      body: {
        text: "goal Inspect the renderer.",
        collapsedRows: 1,
        spacingBefore: 0,
      },
    });
  });
});
