import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleHandoffDraft,
  buildExtractionPrompt,
  extractHandoffContext,
  generateHandoffDraftFromSessionManager,
} from "../extensions/session-handoff/extract.ts";

function generateHandoffDraft(
  ctx: { sessionManager: { getLeafId(): string } },
  goal: string,
  thinkingLevel: "medium",
) {
  return generateHandoffDraftFromSessionManager(
    ctx as never,
    createModelRuntime(),
    ctx.sessionManager as never,
    ctx.sessionManager.getLeafId(),
    goal,
    thinkingLevel,
  );
}

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
        summary: "Relevant context only.",
        relevantFiles: ["src/index.ts", "README.md"],
        openQuestions: [],
      },
      "Implement the command.",
    );

    expect(draft).toContain(
      "Continuing work from session session-123. When you lack specific information you can use session_ask.",
    );
    expect(draft).not.toContain("/tmp/session.jsonl");
    expect(draft.indexOf("## Task")).toBeLessThan(draft.indexOf("## Relevant Files"));
    expect(draft.indexOf("## Relevant Files")).toBeLessThan(draft.indexOf("## Context"));
    expect(draft).not.toContain("## Open Questions");
  });

  it("uses the exact goal as the destination task", () => {
    const draft = assembleHandoffDraft(
      "session-123",
      "/tmp/session.jsonl",
      {
        summary: "Parent context relevant to the goal.",
        relevantFiles: [],
        openQuestions: [],
      },
      "Finish immediately without performing work.",
    );

    expect(draft).toContain("## Task\nFinish immediately without performing work.");
  });

  it("makes response reporting explicit only when requested", () => {
    const draft = assembleHandoffDraft(
      "session-123",
      "/tmp/session.jsonl",
      {
        summary: "Relevant context only.",
        relevantFiles: [],
        openQuestions: [],
      },
      "Research related work.",
      true,
    );

    expect(draft).toContain("When this work is complete, send that session a completion report.");
  });

  it("extracts and normalizes structured tool-call arguments", () => {
    const extraction = extractHandoffContext({
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
            relevantFiles: [" src/index.ts ", "src/index.ts", ""],
            openQuestions: [" Should tests cover cancel? ", ""],
          },
        },
      ],
    });

    expect(extraction).toEqual({
      context: {
        summary: "Keep this.",
        relevantFiles: ["src/index.ts"],
        openQuestions: ["Should tests cover cancel?"],
      },
    });
  });

  it("builds a draft from the deep extraction agent", async () => {
    createAgentSessionMock.mockResolvedValue(
      createMockAgentSession({
        summary: "The command is partly implemented.",
        relevantFiles: ["extensions/session-handoff.ts"],
        openQuestions: ["Should the preview use an overlay?"],
      }),
    );

    const result = await generateHandoffDraft(
      createGenerationContext(),
      "Finish phase 1.",
      "medium",
    );

    expect(result?.sessionId).toBe("session-123");
    expect(result?.draft).toContain("## Task\nFinish phase 1.");
    expect(result?.draft).toContain("## Relevant Files\n- extensions/session-handoff.ts");
    expect(result?.draft).toContain("## Context\nThe command is partly implemented.");
    expect(result?.draft).toContain("## Open Questions\n- Should the preview use an overlay?");

    const [options] = createAgentSessionMock.mock.calls[0] ?? [];
    expect(options).toMatchObject({
      cwd: "/tmp/project",
      model: { provider: "openai", id: "gpt-5.4", reasoning: true },
      modelRuntime: { getModel: expect.any(Function) },
      thinkingLevel: "medium",
      tools: ["read", "grep", "find", "ls", "create_handoff_context"],
    });
    expect(options.customTools).toHaveLength(1);
    expect(Object.keys(options.customTools[0].parameters.properties)).toEqual([
      "summary",
      "relevantFiles",
      "openQuestions",
    ]);
    expect(options.customTools[0].parameters.properties.relevantFiles.maxItems).toBeUndefined();
    expect(options.customTools[0].parameters.properties.openQuestions.maxItems).toBeUndefined();
    expect(options.resourceLoader.getSystemPrompt()).toContain(
      "Do not continue the parent conversation, respond to any questions in it, or carry forward parent tasks",
    );
    expect(options.resourceLoader.getSystemPrompt()).toContain(
      "The parent may be coordinating several parallel sessions. Do not include any references to those other sessions.",
    );
    expect(options.resourceLoader.getAppendSystemPrompt()).toEqual([]);
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

    expect(prompt).toContain("<conversation>\n[User]: Please implement phase 1.\n</conversation>");
    expect(prompt).toContain("<handoff-goal>\nFinish phase 1.\n</handoff-goal>");
    expect(prompt).not.toContain("Call create_handoff_context exactly once.");
  });

  it("does not truncate extracted files or questions", async () => {
    const relevantFiles = Array.from({ length: 20 }, (_, index) => `file-${index}.ts`);
    const openQuestions = Array.from({ length: 20 }, (_, index) => `Question ${index}?`);
    createAgentSessionMock.mockResolvedValue(
      createMockAgentSession({
        summary: "Relevant context.",
        relevantFiles,
        openQuestions,
      }),
    );

    const result = await generateHandoffDraft(
      createGenerationContext(),
      "Finish phase 1.",
      "medium",
    );

    expect(result?.context.relevantFiles).toEqual(relevantFiles);
    expect(result?.context.openQuestions).toEqual(openQuestions);
  });

  it("rejects extraction runs that do not call the structured tool", async () => {
    createAgentSessionMock.mockResolvedValue(createMockAgentSession(undefined));

    await expect(
      generateHandoffDraft(createGenerationContext(), "Finish phase 1.", "medium"),
    ).rejects.toThrow("Handoff extraction did not return structured context.");
  });

  it("includes the goal and source snapshot in the extraction prompt", () => {
    const prompt = buildExtractionPrompt("user: hello", "Finish phase 1.");

    expect(prompt).toContain("<conversation>\nuser: hello\n</conversation>");
    expect(prompt).toContain("<handoff-goal>\nFinish phase 1.\n</handoff-goal>");
  });

  it("builds extraction context only from the anchored source branch", async () => {
    let prompt = "";
    createAgentSessionMock.mockResolvedValue(
      createMockAgentSession(undefined, (value) => {
        prompt = value;
      }),
    );

    const entries = [
      messageEntry("root", null, "user", "ROOT SOURCE"),
      messageEntry("anchor", "root", "user", "ANCHOR SOURCE"),
      {
        ...messageEntry("invocation", "anchor", "assistant", ""),
        message: {
          ...messageEntry("invocation", "anchor", "assistant", "").message,
          content: [
            {
              type: "toolCall",
              id: "handoff-call",
              name: "session_handoff",
              arguments: { goal: "TARGET GOAL", launch: "deferred" },
            },
          ],
        },
      },
      messageEntry("result", "invocation", "toolResult", "SELF CHILD child-session-999"),
      messageEntry("later", "result", "assistant", "LATER PARENT COORDINATION"),
      messageEntry("sibling", "anchor", "user", "SIBLING BRANCH"),
    ];
    const sourceSessionManager = createSourceSessionManager(entries, "later");

    await expect(
      generateHandoffDraftFromSessionManager(
        createGenerationContext(),
        createModelRuntime(),
        sourceSessionManager as never,
        "anchor",
        "TARGET GOAL",
        "medium",
      ),
    ).rejects.toThrow("Handoff extraction did not return structured context.");

    expect(prompt).toContain("ROOT SOURCE");
    expect(prompt).toContain("ANCHOR SOURCE");
    expect(prompt).toContain("TARGET GOAL");
    expect(prompt).not.toContain("session_handoff");
    expect(prompt).not.toContain("SELF CHILD");
    expect(prompt).not.toContain("LATER PARENT COORDINATION");
    expect(prompt).not.toContain("SIBLING BRANCH");
  });

  it("rejects a missing source snapshot instead of falling back to the latest leaf", async () => {
    const entries = [messageEntry("latest", null, "user", "LATEST CONTENT")];

    await expect(
      generateHandoffDraftFromSessionManager(
        createGenerationContext(),
        createModelRuntime(),
        createSourceSessionManager(entries, "latest") as never,
        "missing-anchor",
        "TARGET GOAL",
        "medium",
      ),
    ).rejects.toThrow("Handoff source snapshot entry missing-anchor was not found.");

    expect(createAgentSessionMock).not.toHaveBeenCalled();
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

function createModelRuntime() {
  return {
    getModel: () => ({ provider: "openai", id: "gpt-5.4", reasoning: true }),
  } as never;
}

function createGenerationContext() {
  const modelRegistry = {
    async getApiKeyAndHeaders() {
      return { ok: true, apiKey: "test-key", headers: undefined };
    },
  };

  const entries = [messageEntry("user-1", null, "user", "Please implement phase 1.")];

  return {
    cwd: "/tmp/project",
    model: { provider: "openai", id: "gpt-5.4", reasoning: true },
    modelRegistry,
    sessionManager: {
      getEntries() {
        return entries;
      },
      getEntry(id: string) {
        return entries.find((entry) => entry.id === id);
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

function createSourceSessionManager(entries: unknown[], leafId: string) {
  return {
    getEntries: () => entries,
    getEntry: (id: string) => entries.find((entry) => (entry as { id?: string }).id === id),
    getLeafId: () => leafId,
    getSessionId: () => "source-session",
    getSessionFile: () => "/tmp/source-session.jsonl",
  };
}

function messageEntry(id: string, parentId: string | null, role: string, text: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-03-23T00:00:00.000Z",
    message: {
      role,
      content: [{ type: "text", text }],
      timestamp: 1,
    },
  };
}
