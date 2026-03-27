import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleHandoffDraft,
  buildExtractionPrompt,
  extractHandoffContext,
  generateHandoffDraft,
} from "../extensions/session-handoff/extract.js";

const { completeMock } = vi.hoisted(() => ({
  completeMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<object>("@mariozechner/pi-ai");
  return {
    ...actual,
    complete: completeMock,
  };
});

afterEach(() => {
  completeMock.mockReset();
});

describe("session handoff extraction", () => {
  it("assembles the draft in the expected order and omits empty sections", () => {
    const draft = assembleHandoffDraft(
      "session-123",
      "/tmp/session.jsonl",
      {
        summary: "Relevant context only.",
        relevantFiles: ["src/index.ts", "README.md"],
        nextTask: "Implement the command.",
        openQuestions: [],
      },
      "Ignored fallback goal",
    );

    expect(draft).toContain(
      "Continuing work from session session-123. When you lack specific information you can use session_ask.",
    );
    expect(draft).not.toContain("/tmp/session.jsonl");
    expect(draft.indexOf("## Task")).toBeLessThan(draft.indexOf("## Relevant Files"));
    expect(draft.indexOf("## Relevant Files")).toBeLessThan(draft.indexOf("## Context"));
    expect(draft).not.toContain("## Open Questions");
  });

  it("extracts and normalizes structured tool-call arguments", () => {
    const handoffContext = extractHandoffContext(
      {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 0,
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "create_handoff_context",
            arguments: {
              summary: "  Keep this.  ",
              relevantFiles: [" src/index.ts ", "src/index.ts", "", 1],
              nextTask: "  Implement the command. ",
              openQuestions: [" Should tests cover cancel? ", "", null],
            },
          },
        ],
      },
      "fallback goal",
    );

    expect(handoffContext).toEqual({
      summary: "Keep this.",
      relevantFiles: ["src/index.ts"],
      nextTask: "Implement the command.",
      openQuestions: ["Should tests cover cancel?"],
    });
  });

  it("builds a draft from a structured tool call", async () => {
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "create_handoff_context",
          arguments: {
            summary: "The command is partly implemented.",
            relevantFiles: ["extensions/session-handoff.ts"],
            nextTask: "Finish phase 1 and verify it.",
            openQuestions: ["Should the preview use an overlay?"],
          },
        },
      ],
    });

    const result = await generateHandoffDraft(createGenerationContext(), "Finish phase 1.");

    expect(result?.sessionId).toBe("session-123");
    expect(result?.draft).toContain("## Task\nFinish phase 1 and verify it.");
    expect(result?.draft).toContain("## Relevant Files\n- extensions/session-handoff.ts");
    expect(result?.draft).toContain("## Context\nThe command is partly implemented.");
    expect(result?.draft).toContain("## Open Questions\n- Should the preview use an overlay?");

    const [model, context, options] = completeMock.mock.calls[0] ?? [];
    expect(model).toEqual({ provider: "openai", id: "gpt-5.4" });
    expect(context.tools).toHaveLength(1);
    expect(options).toMatchObject({ apiKey: "test-key", toolChoice: "any" });
  });

  it("rejects responses without the structured tool call", async () => {
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "I forgot the tool call." }],
    });

    await expect(
      generateHandoffDraft(createGenerationContext(), "Finish phase 1."),
    ).rejects.toThrow("Handoff extraction did not return structured context.");
  });

  it("includes the goal and conversation in the extraction prompt", () => {
    const prompt = buildExtractionPrompt("user: hello", "Finish phase 1.");

    expect(prompt).toContain("## Conversation\nuser: hello");
    expect(prompt).toContain("## Goal\nFinish phase 1.");
    expect(prompt).toContain("Call create_handoff_context exactly once.");
  });
});

function createGenerationContext() {
  return {
    model: { provider: "openai", id: "gpt-5.4" },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "test-key", headers: undefined };
      },
    },
    sessionManager: {
      getEntries() {
        return [
          {
            type: "message",
            id: "user-1",
            parentId: null,
            timestamp: "2026-03-23T00:00:00.000Z",
            message: {
              role: "user",
              content: [{ type: "text", text: "Please implement phase 1." }],
              timestamp: 1,
            },
          },
        ];
      },
      getLeafId() {
        return "user-1";
      },
      getSessionId() {
        return "session-123";
      },
      getSessionFile() {
        return "/tmp/session.jsonl";
      },
    },
  } as never;
}
