import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleHandoffDraft,
  buildExtractionPrompt,
  extractHandoffContext,
  generateHandoffDraftFromSessionManager,
} from "../extensions/session-handoff/extract.ts";
import type { HandoffSettings } from "../extensions/shared/settings.ts";
import { createFakeModelRuntime } from "./test-helpers.ts";

function generateHandoffDraft(
  ctx: { sessionManager: { getLeafId(): string } },
  goal: string,
  thinkingLevel: "medium",
) {
  return generateHandoffDraftFromSessionManager({
    ctx: ctx as never,
    modelRuntime: createModelRuntime(),
    sourceSessionManager: ctx.sessionManager as never,
    sourceLeafId: ctx.sessionManager.getLeafId(),
    goal,
    settings: createHandoffSettings(),
    destinationThinkingLevel: thinkingLevel,
  });
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
  vi.restoreAllMocks();
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

  it("builds a draft from a single extraction turn", async () => {
    const onPrompt = vi.fn();
    createAgentSessionMock.mockResolvedValue(
      createMockAgentSession(
        {
          summary: "The command is partly implemented.",
          relevantFiles: ["extensions/session-handoff.ts"],
          openQuestions: ["Should the preview use an overlay?"],
        },
        onPrompt,
      ),
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
    expect(onPrompt).toHaveBeenCalledOnce();

    const [options] = createAgentSessionMock.mock.calls[0] ?? [];
    expect(options).toMatchObject({
      cwd: "/tmp/project",
      model: { provider: "openai", id: "gpt-5.4", reasoning: true },
      modelRuntime: { getModel: expect.any(Function) },
      thinkingLevel: "medium",
      tools: ["create_handoff_context"],
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

  it("uses the configured model and thinking level", async () => {
    const extractionModel = {
      provider: "openai-codex",
      id: "gpt-5.6-terra",
    };
    const modelRuntime = createFakeModelRuntime({ available: [extractionModel as never] });
    createAgentSessionMock.mockResolvedValue(
      createMockAgentSession({ summary: "Configured extraction.", relevantFiles: [] }),
    );
    const ctx = createGenerationContext();
    const sourceSessionManager = createSourceSessionManager(
      [messageEntry("user-1", null, "user", "Please implement phase 1.")],
      "user-1",
    );

    await generateHandoffDraftFromSessionManager({
      ctx,
      modelRuntime: modelRuntime as never,
      sourceSessionManager: sourceSessionManager as never,
      sourceLeafId: "user-1",
      goal: "Finish phase 1.",
      settings: {
        ...createHandoffSettings(),
        model: "openai-codex/gpt-5.6-terra",
        thinkingLevel: "low",
      },
      destinationThinkingLevel: "medium",
    });

    expect(createAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: extractionModel,
        thinkingLevel: "low",
      }),
    );
  });

  it("passes the serialized conversation and goal, then uses the exact backstop prompt", async () => {
    const prompts: string[] = [];
    createAgentSessionMock.mockResolvedValue(
      createMockAgentSession(undefined, (value) => {
        prompts.push(value);
      }),
    );

    await expect(
      generateHandoffDraft(createGenerationContext(), "Finish phase 1.", "medium"),
    ).rejects.toThrow("Handoff extraction did not return structured context.");

    expect(prompts[0]).toContain(
      "<conversation>\n[User]: Please implement phase 1.\n</conversation>",
    );
    expect(prompts[0]).toContain("<handoff-goal>\nFinish phase 1.\n</handoff-goal>");
    expect(prompts).toEqual([
      expect.stringContaining("<handoff-goal>\nFinish phase 1.\n</handoff-goal>"),
      "You did not call create_handoff_context. Call it exactly once now with the completed briefing.",
      "You did not call create_handoff_context. Call it exactly once now with the completed briefing.",
    ]);
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

  it("re-prompts once when the first turn omits the structured tool", async () => {
    const prompts: string[] = [];
    createAgentSessionMock.mockResolvedValue(
      createMockAgentSession(
        (promptIndex: number) =>
          promptIndex === 1
            ? {
                summary: "Captured on retry.",
                relevantFiles: [],
              }
            : undefined,
        (prompt) => prompts.push(prompt),
      ),
    );

    const result = await generateHandoffDraft(
      createGenerationContext(),
      "Finish phase 1.",
      "medium",
    );

    expect(result?.context.summary).toBe("Captured on retry.");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(
      "You did not call create_handoff_context. Call it exactly once now with the completed briefing.",
    );
  });

  it("stops on a provider error instead of re-prompting a failed turn", async () => {
    const onPrompt = vi.fn();
    createAgentSessionMock.mockResolvedValue(
      createMockAgentSession(undefined, onPrompt, {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Codex error: The usage limit has been reached",
      }),
    );

    await expect(
      generateHandoffDraft(createGenerationContext(), "Finish phase 1.", "medium"),
    ).rejects.toThrow("Handoff extraction failed: Codex error: The usage limit has been reached");
    expect(onPrompt).toHaveBeenCalledOnce();
  });

  it("rejects extraction runs after three turns without the structured tool", async () => {
    const onPrompt = vi.fn();
    createAgentSessionMock.mockResolvedValue(createMockAgentSession(undefined, onPrompt));

    await expect(
      generateHandoffDraft(createGenerationContext(), "Finish phase 1.", "medium"),
    ).rejects.toThrow("Handoff extraction did not return structured context.");
    expect(onPrompt).toHaveBeenCalledTimes(3);
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
        prompt ||= value;
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
      generateHandoffDraftFromSessionManager({
        ctx: createGenerationContext(),
        modelRuntime: createModelRuntime(),
        sourceSessionManager: sourceSessionManager as never,
        sourceLeafId: "anchor",
        goal: "TARGET GOAL",
        settings: createHandoffSettings(),
        destinationThinkingLevel: "medium",
      }),
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
      generateHandoffDraftFromSessionManager({
        ctx: createGenerationContext(),
        modelRuntime: createModelRuntime(),
        sourceSessionManager: createSourceSessionManager(entries, "latest") as never,
        sourceLeafId: "missing-anchor",
        goal: "TARGET GOAL",
        settings: createHandoffSettings(),
        destinationThinkingLevel: "medium",
      }),
    ).rejects.toThrow("Handoff source snapshot entry missing-anchor was not found.");

    expect(createAgentSessionMock).not.toHaveBeenCalled();
  });

  it("keeps extraction runs in memory when persistence is disabled", async () => {
    const inMemoryManager = { getSessionFile: vi.fn() };
    const inMemorySpy = vi
      .spyOn(SessionManager, "inMemory")
      .mockReturnValue(inMemoryManager as never);
    const createSpy = vi.spyOn(SessionManager, "create");
    createAgentSessionMock.mockResolvedValue(
      createMockAgentSession({ summary: "In memory.", relevantFiles: [] }),
    );

    const result = await generateHandoffDraft(
      createGenerationContext(),
      "Finish phase 1.",
      "medium",
    );

    expect(inMemorySpy).toHaveBeenCalledWith("/tmp/project");
    expect(createSpy).not.toHaveBeenCalled();
    expect(inMemoryManager.getSessionFile).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("debugSessionPath");
  });

  it("persists extraction runs and returns their session path when enabled", async () => {
    const persistedManager = {
      getSessionFile: vi.fn(() => "/tmp/handoff-runs/extraction.jsonl"),
    };
    const createSpy = vi.spyOn(SessionManager, "create").mockReturnValue(persistedManager as never);
    const inMemorySpy = vi.spyOn(SessionManager, "inMemory");
    createAgentSessionMock.mockResolvedValue(
      createMockAgentSession({ summary: "Persisted.", relevantFiles: [] }),
    );
    const ctx = createGenerationContext();
    const sourceSessionManager = createSourceSessionManager(
      [messageEntry("user-1", null, "user", "Please implement phase 1.")],
      "user-1",
    );

    const result = await generateHandoffDraftFromSessionManager({
      ctx,
      modelRuntime: createModelRuntime(),
      sourceSessionManager: sourceSessionManager as never,
      sourceLeafId: "user-1",
      goal: "Finish phase 1.",
      settings: createHandoffSettings(true),
      destinationThinkingLevel: "medium",
    });

    expect(createSpy).toHaveBeenCalledWith(
      "/tmp/project",
      expect.stringMatching(/pi-sessions\/session-handoff$/),
    );
    expect(inMemorySpy).not.toHaveBeenCalled();
    expect(result?.debugSessionPath).toBe("/tmp/handoff-runs/extraction.jsonl");
  });
});

function createMockAgentSession(
  toolArguments: unknown | ((promptIndex: number) => unknown),
  onPrompt?: (prompt: string) => void,
  assistantMessage?: { role: "assistant"; stopReason: string; errorMessage?: string },
) {
  let promptIndex = 0;
  return {
    session: {
      messages: assistantMessage ? [assistantMessage] : [],
      async prompt(prompt: string) {
        onPrompt?.(prompt);
        const currentPromptIndex = promptIndex;
        promptIndex += 1;
        const resolvedArguments =
          typeof toolArguments === "function" ? toolArguments(currentPromptIndex) : toolArguments;
        if (!resolvedArguments) {
          return;
        }

        const [options] = createAgentSessionMock.mock.calls.at(-1) ?? [];
        const [tool] = options.customTools;
        await tool.execute("call-1", resolvedArguments);
      },
      async abort() {},
      dispose() {},
    },
    extensionsResult: { extensions: [], errors: [] },
  };
}

function createHandoffSettings(persistRuns = false): HandoffSettings {
  return {
    pickerShortcut: "alt+o",
    roster: [],
    persistRuns,
    deferred: { copyToClipboard: true },
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
