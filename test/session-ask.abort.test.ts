import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSessionMock,
  loadSessionNavigationDataMock,
  promptMock,
  abortMock,
  disposeMock,
} = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  loadSessionNavigationDataMock: vi.fn(),
  promptMock: vi.fn(),
  abortMock: vi.fn(),
  disposeMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: createAgentSessionMock,
  DefaultResourceLoader: class {
    async reload(): Promise<void> {}
  },
  getAgentDir: () => "/tmp/agent-dir",
  SessionManager: {
    inMemory: () => ({}),
    create: () => ({ getSessionFile: () => "/tmp/ask-run.jsonl" }),
  },
  defineTool: (definition: unknown) => definition,
}));

vi.mock("../extensions/session-ask/navigate.ts", () => ({
  loadSessionNavigationData: loadSessionNavigationDataMock,
  buildSessionMap: () => "(map)",
  buildSessionMetadata: () => ({
    sessionId: "session-1",
    sessionName: "Test Session",
    cwd: "/repo/app",
    startedAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    entryCount: 2,
    messageCount: 2,
  }),
  readProjectAgentsMd: () => undefined,
  findBranchesForEntry: () => [],
  findSpanForEntry: () => undefined,
  readEntriesFromEntry: () => ({ entries: [] }),
}));

interface CapturedTool {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<unknown>;
}

function setupFakeSession(): { getTool: (name: string) => CapturedTool } {
  let customTools: CapturedTool[] = [];
  createAgentSessionMock.mockImplementation(async (options: { customTools: CapturedTool[] }) => {
    customTools = options.customTools;
    return {
      session: {
        prompt: promptMock,
        abort: abortMock,
        dispose: disposeMock,
      },
    };
  });

  return {
    getTool(name: string) {
      const tool = customTools.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new Error(`Tool ${name} was not registered.`);
      }
      return tool;
    },
  };
}

function baseParams(signal?: AbortSignal) {
  return {
    ctx: {
      model: { provider: "openai", id: "gpt-5.4" },
      modelRegistry: { getAvailable: () => [] },
    } as never,
    target: {
      sessionId: "session-1",
      sessionPath: "/tmp/session-1.jsonl",
    } as never,
    question: "What happened?",
    indexPath: "/tmp/index.sqlite",
    askSettings: undefined,
    thinkingLevel: undefined,
    signal,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadSessionNavigationDataMock.mockReturnValue({
    header: { cwd: "/repo/app" },
    entrySizes: new Map(),
    spans: [],
  });
  abortMock.mockResolvedValue(undefined);
  promptMock.mockResolvedValue(undefined);
});

describe("session_ask abort handling", () => {
  it("stops before loading anything when the signal is already aborted", async () => {
    const { runSessionAskAgent } = await import("../extensions/session-ask/agent.ts");
    const controller = new AbortController();
    controller.abort();

    await expect(runSessionAskAgent(baseParams(controller.signal))).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(loadSessionNavigationDataMock).not.toHaveBeenCalled();
    expect(createAgentSessionMock).not.toHaveBeenCalled();
  });

  it("aborts the nested session once mid-prompt and never retries", async () => {
    setupFakeSession();
    const { runSessionAskAgent } = await import("../extensions/session-ask/agent.ts");
    const controller = new AbortController();

    promptMock.mockImplementation(async () => {
      controller.abort();
    });

    await expect(runSessionAskAgent(baseParams(controller.signal))).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(abortMock).toHaveBeenCalledTimes(1);
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("awaits an in-flight nested abort before disposing", async () => {
    setupFakeSession();
    const { runSessionAskAgent } = await import("../extensions/session-ask/agent.ts");
    const controller = new AbortController();

    let abortSettled = false;
    abortMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            abortSettled = true;
            resolve();
          }, 10);
        }),
    );
    disposeMock.mockImplementation(() => {
      expect(abortSettled).toBe(true);
    });
    promptMock.mockImplementation(async () => {
      controller.abort();
    });

    await expect(runSessionAskAgent(baseParams(controller.signal))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("retries up to three times and returns undefined when no answer is captured", async () => {
    setupFakeSession();
    const { runSessionAskAgent } = await import("../extensions/session-ask/agent.ts");

    const result = await runSessionAskAgent(baseParams(undefined));

    expect(result).toBeUndefined();
    expect(promptMock).toHaveBeenCalledTimes(3);
    expect(abortMock).not.toHaveBeenCalled();
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("returns the captured answer without aborting", async () => {
    const fake = setupFakeSession();
    const { runSessionAskAgent } = await import("../extensions/session-ask/agent.ts");

    promptMock.mockImplementation(async () => {
      await fake.getTool("provide_results").execute("call-1", {
        answer: " The fix landed in commit abc123. ",
        relevantFiles: [{ path: "/repo/app/src/fix.ts", reason: "Contains the fix" }],
      });
    });

    const result = await runSessionAskAgent(baseParams(undefined));

    expect(result).toMatchObject({
      answer: "The fix landed in commit abc123.",
      relevantFiles: [{ path: "/repo/app/src/fix.ts", reason: "Contains the fix" }],
    });
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(abortMock).not.toHaveBeenCalled();
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });
});
