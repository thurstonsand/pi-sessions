import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleHandoffDraft,
  buildExtractionPrompt,
  extractHandoffContext,
  generateHandoffDraft,
} from "../extensions/session-handoff/extract.ts";

const { createAgentSessionMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<object>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: createAgentSessionMock,
  };
});

afterEach(() => {
  createAgentSessionMock.mockReset();
});

describe("session handoff extraction", () => {
  it("assembles the draft in the expected order and omits empty sections", () => {
    const draft = assembleHandoffDraft(
      "session-123",
      "/tmp/session.jsonl",
      {
        title: "Implement handoff command",
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

  it("makes response reporting explicit only when requested", () => {
    const draft = assembleHandoffDraft(
      "session-123",
      "/tmp/session.jsonl",
      {
        title: "Research related work",
        summary: "Relevant context only.",
        relevantFiles: [],
        nextTask: "Research unrelated follow-up work.",
        openQuestions: [],
      },
      "Ignored fallback goal",
      true,
    );

    expect(draft).toContain(
      "When this work is complete, send that session a completion report with session_send_message.",
    );
  });

  it("extracts and normalizes structured tool-call arguments", () => {
    const extraction = extractHandoffContext(
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
              title: "  Implement handoff command  ",
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

    expect(extraction).toEqual({
      context: {
        title: "Implement handoff command",
        summary: "Keep this.",
        relevantFiles: ["src/index.ts"],
        nextTask: "Implement the command.",
        openQuestions: ["Should tests cover cancel?"],
      },
    });
  });

  it("builds a draft from the deep extraction agent", async () => {
    createAgentSessionMock.mockResolvedValue(
      createMockAgentSession({
        title: "Finish handoff phase 1",
        summary: "The command is partly implemented.",
        relevantFiles: ["extensions/session-handoff.ts"],
        nextTask: "Finish phase 1 and verify it.",
        openQuestions: ["Should the preview use an overlay?"],
      }),
    );

    const result = await generateHandoffDraft(
      createGenerationContext(),
      "Finish phase 1.",
      "medium",
    );

    expect(result?.sessionId).toBe("session-123");
    expect(result?.context.title).toBe("Finish handoff phase 1");
    expect(result?.draft).toContain("## Task\nFinish phase 1 and verify it.");
    expect(result?.draft).toContain("## Relevant Files\n- extensions/session-handoff.ts");
    expect(result?.draft).toContain("## Context\nThe command is partly implemented.");
    expect(result?.draft).toContain("## Open Questions\n- Should the preview use an overlay?");

    const [options] = createAgentSessionMock.mock.calls[0] ?? [];
    expect(options).toMatchObject({
      cwd: "/tmp/project",
      model: { provider: "openai", id: "gpt-5.4", reasoning: true },
      thinkingLevel: "medium",
      tools: ["read", "grep", "find", "ls", "create_handoff_context"],
    });
    expect(options.customTools).toHaveLength(1);
  });

  it("passes the serialized conversation and goal to the deep extraction agent", async () => {
    let prompt = "";
    createAgentSessionMock.mockResolvedValue(
      createMockAgentSession(undefined, (value) => {
        prompt = value;
      }),
    );

    await expect(
      generateHandoffDraft(createGenerationContext(), "Finish phase 1.", "medium"),
    ).rejects.toThrow("Handoff extraction did not return structured context.");

    expect(prompt).toContain("## Conversation\n[User]: Please implement phase 1.");
    expect(prompt).toContain("## Goal\nFinish phase 1.");
    expect(prompt).toContain("Call create_handoff_context exactly once.");
  });

  it("rejects generated titles longer than 64 characters", async () => {
    createAgentSessionMock.mockResolvedValue(
      createMockAgentSession({
        title:
          "This generated handoff title is intentionally much longer than sixty four characters",
        summary: "The command is partly implemented.",
        relevantFiles: [],
        nextTask: "Finish phase 1 and verify it.",
      }),
    );

    await expect(
      generateHandoffDraft(createGenerationContext(), "Finish phase 1.", "medium"),
    ).rejects.toThrow("Handoff title must be 64 characters or less.");
  });

  it("rejects extraction runs that do not call the structured tool", async () => {
    createAgentSessionMock.mockResolvedValue(createMockAgentSession(undefined));

    await expect(
      generateHandoffDraft(createGenerationContext(), "Finish phase 1.", "medium"),
    ).rejects.toThrow("Handoff extraction did not return structured context.");
  });

  it("includes the goal and conversation in the extraction prompt", () => {
    const prompt = buildExtractionPrompt("user: hello", "Finish phase 1.");

    expect(prompt).toContain("## Conversation\nuser: hello");
    expect(prompt).toContain("## Goal\nFinish phase 1.");
    expect(prompt).toContain("Call create_handoff_context exactly once.");
  });
});

function createMockAgentSession(toolArguments: unknown, onPrompt?: (prompt: string) => void) {
  return {
    session: {
      async prompt(prompt: string) {
        onPrompt?.(prompt);
        if (!toolArguments) {
          return;
        }

        const [options] = createAgentSessionMock.mock.calls.at(-1) ?? [];
        const [tool] = options.customTools;
        await tool.execute("call-1", toolArguments);
      },
      async abort() {},
      dispose() {},
    },
    extensionsResult: { extensions: [], errors: [] },
  };
}

function createGenerationContext() {
  const modelRegistry = {
    async getApiKeyAndHeaders() {
      return { ok: true, apiKey: "test-key", headers: undefined };
    },
  };

  return {
    cwd: "/tmp/project",
    model: { provider: "openai", id: "gpt-5.4", reasoning: true },
    modelRegistry,
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
