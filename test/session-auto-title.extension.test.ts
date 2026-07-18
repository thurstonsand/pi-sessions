import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSettings } from "../extensions/shared/settings.ts";
import { createFakeModelRegistry, createFakeModelRuntime } from "./test-helpers.ts";

const { completeSimpleMock, loadSettingsMock } = vi.hoisted(() => ({
  completeSimpleMock: vi.fn(),
  loadSettingsMock: vi.fn(),
}));

vi.mock("../extensions/shared/settings.ts", () => ({
  loadSettings: loadSettingsMock,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  loadSettingsMock.mockReturnValue({
    autoTitle: {
      refreshTurns: 4,
      timeoutMs: 15_000,
      model: "google/gemini-flash-lite-latest",
      prompt: "Default auto-title prompt",
    },
  });
});

describe("session auto-title extension", () => {
  it("uses the current session model when cheap models are unavailable", async () => {
    const { installAutoTitle } = await import("../extensions/session-auto-title/install.ts");
    const { commands, pi } = createExtensionApi();

    const lifecycle = installAutoTitle(pi as never, buildDeps());
    const title = commands.get("title");
    expect(lifecycle.onSessionStart).toBeDefined();
    expect(title).toBeDefined();

    const currentModel = { provider: "openai", id: "gpt-5.4-mini" };
    const ctx = createRetitleContext({
      availableModels: [],
      currentModel,
    });
    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "Resolved Title" }],
    });

    await lifecycle.onSessionStart?.({} as never, ctx as never);
    await title?.("", ctx as never);

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(completeSimpleMock.mock.calls[0]?.[0]).toEqual(currentModel);
    expect(pi.setSessionName).toHaveBeenCalledWith("Resolved Title");
  });

  it("uses the configured auto-title prompt in the user request", async () => {
    loadSettingsMock.mockReturnValue({
      autoTitle: {
        refreshTurns: 4,
        timeoutMs: 15_000,
        model: "google/gemini-flash-lite-latest",
        prompt: "Name sessions like terse incident reports.",
      },
    });
    const { installAutoTitle } = await import("../extensions/session-auto-title/install.ts");
    const { commands, pi } = createExtensionApi();

    const lifecycle = installAutoTitle(pi as never, buildDeps());
    const title = commands.get("title");
    const configuredModel = { provider: "google", id: "gemini-flash-lite-latest" };
    const ctx = createRetitleContext({
      availableModels: [configuredModel],
      currentModel: { provider: "openai", id: "gpt-5.4-mini" },
    });
    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "Incident Report Title" }],
    });

    await lifecycle.onSessionStart?.({} as never, ctx as never);
    await title?.("", ctx as never);

    const requestContext = completeSimpleMock.mock.calls[0]?.[1];
    const promptText = requestContext?.messages[0]?.content[0]?.text;
    expect(requestContext).toMatchObject({
      systemPrompt: "Name sessions like terse incident reports.",
    });
    expect(promptText).toContain("<session_context>");
    expect(promptText).toContain(
      "<title_instructions>\nName sessions like terse incident reports.\n</title_instructions>",
    );
    expect(promptText).not.toContain("<current_title>");
  });

  it("adds current-title preservation instructions only for periodic retitles", async () => {
    const { generateAutoTitle } = await import("../extensions/session-auto-title/generate.ts");
    const ctx = createRetitleContext({
      availableModels: [],
      currentModel: { provider: "openai", id: "gpt-5.4-mini" },
    });
    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "Updated Title" }],
    });
    const modelRuntime = createRuntime(ctx);

    await generateAutoTitle(
      modelRuntime,
      { provider: "openai", id: "gpt-5.4-mini" } as never,
      {
        cwd: "/repo/app",
        currentTitle: "Existing Title",
        conversationText: "user: keep working",
        userTurnCount: 5,
        assistantTurnCount: 4,
      },
      "manual",
      { systemPrompt: "Name this coding session.", timeoutMs: 15_000, thinkingLevel: undefined },
    );
    await generateAutoTitle(
      modelRuntime,
      { provider: "openai", id: "gpt-5.4-mini" } as never,
      {
        cwd: "/repo/app",
        currentTitle: "Existing Title",
        conversationText: "user: keep working",
        userTurnCount: 5,
        assistantTurnCount: 4,
      },
      "periodic",
      { systemPrompt: "Name this coding session.", timeoutMs: 15_000, thinkingLevel: undefined },
    );

    const manualRequestContext = completeSimpleMock.mock.calls[0]?.[1];
    const periodicRequestContext = completeSimpleMock.mock.calls[1]?.[1];
    const manualPrompt = manualRequestContext.messages[0]?.content[0]?.text;
    const periodicPrompt = periodicRequestContext.messages[0]?.content[0]?.text;
    expect(manualRequestContext.systemPrompt).toBe("Name this coding session.");
    expect(manualPrompt).toContain(
      "<title_instructions>\nName this coding session.\n</title_instructions>",
    );
    expect(manualPrompt).not.toContain("<current_title>");
    expect(periodicRequestContext.systemPrompt).toBe(
      "Name this coding session.\n\nPreserve the current title unless the conversation has meaningfully shifted.",
    );
    expect(periodicPrompt).toContain("<current_title>Existing Title</current_title>");
    expect(periodicPrompt).toContain(
      "<title_instructions>\nName this coding session.\n\nPreserve the current title unless the conversation has meaningfully shifted.\n</title_instructions>",
    );
  });

  it("passes the configured thinking level through as reasoning, omitting it for off", async () => {
    const { generateAutoTitle } = await import("../extensions/session-auto-title/generate.ts");
    const ctx = createRetitleContext({
      availableModels: [],
      currentModel: { provider: "openai", id: "gpt-5.4-mini" },
    });
    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "Reasoned Title" }],
    });

    const titleContext = {
      cwd: "/repo/app",
      currentTitle: undefined,
      conversationText: "user: hello",
      userTurnCount: 1,
      assistantTurnCount: 1,
    };
    const model = { provider: "openai", id: "gpt-5.4-mini" } as never;
    const modelRuntime = createRuntime(ctx);
    await generateAutoTitle(modelRuntime, model, titleContext, "manual", {
      systemPrompt: "Name this coding session.",
      timeoutMs: 15_000,
      thinkingLevel: "max",
    });
    await generateAutoTitle(modelRuntime, model, titleContext, "manual", {
      systemPrompt: "Name this coding session.",
      timeoutMs: 15_000,
      thinkingLevel: "off",
    });
    await generateAutoTitle(modelRuntime, model, titleContext, "manual", {
      systemPrompt: "Name this coding session.",
      timeoutMs: 15_000,
      thinkingLevel: undefined,
    });

    expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({ reasoning: "max" });
    expect(completeSimpleMock.mock.calls[1]?.[2]).not.toHaveProperty("reasoning");
    expect(completeSimpleMock.mock.calls[2]?.[2]).not.toHaveProperty("reasoning");
  });

  it("does not retry a second model after startup picks one resolved model", async () => {
    const { installAutoTitle } = await import("../extensions/session-auto-title/install.ts");
    const { commands, pi } = createExtensionApi();

    const lifecycle = installAutoTitle(pi as never, buildDeps());
    const title = commands.get("title");
    expect(lifecycle.onSessionStart).toBeDefined();
    expect(title).toBeDefined();

    const configuredModel = { provider: "google", id: "gemini-flash-lite-latest" };
    const currentModel = { provider: "openai", id: "gpt-5.4-mini" };
    const ctx = createRetitleContext({
      availableModels: [configuredModel],
      currentModel,
    });
    completeSimpleMock.mockResolvedValue({
      stopReason: "error",
      errorMessage: "quota exceeded",
      content: [],
    });

    await lifecycle.onSessionStart?.({} as never, ctx as never);
    await title?.("", ctx as never);

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(completeSimpleMock.mock.calls[0]?.[0]).toEqual(configuredModel);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Session retitle failed.", "error");
  });

  it("surfaces background auto-title failures as a warning notification", async () => {
    const { installAutoTitle } = await import("../extensions/session-auto-title/install.ts");
    const { handlers, pi } = createExtensionApi();

    const lifecycle = installAutoTitle(pi as never, buildDeps());
    const turnEnd = handlers.get("turn_end");
    expect(lifecycle.onSessionStart).toBeDefined();
    expect(turnEnd).toBeDefined();

    const configuredModel = { provider: "google", id: "gemini-flash-lite-latest" };
    const ctx = createRetitleContext({
      availableModels: [configuredModel],
      currentModel: { provider: "openai", id: "gpt-5.4-mini" },
      hasUI: true,
    });
    completeSimpleMock.mockResolvedValue({
      stopReason: "error",
      errorMessage: "quota exceeded",
      content: [],
    });

    await lifecycle.onSessionStart?.({} as never, ctx as never);
    await turnEnd?.({}, ctx as never);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Auto-title failed: quota exceeded. Open /title for details.",
      "warning",
    );
  });
});

function createRuntime(ctx: {
  modelRegistry: {
    getAll(): Array<{ provider: string; id: string }>;
    getAvailable(): Array<{ provider: string; id: string }>;
  };
}) {
  return createFakeModelRuntime({
    all: ctx.modelRegistry.getAll(),
    available: ctx.modelRegistry.getAvailable(),
    completeSimple: completeSimpleMock,
  }) as never;
}

function buildDeps() {
  return {
    settings: loadSettingsMock() as SessionSettings,
    getModelRuntime: async (modelRegistry: {
      getAll(): Array<{ provider: string; id: string }>;
      getAvailable(): Array<{ provider: string; id: string }>;
    }) =>
      createFakeModelRuntime({
        all: modelRegistry.getAll(),
        available: modelRegistry.getAvailable(),
        completeSimple: completeSimpleMock,
      }) as never,
    getSessionEpoch: () => 0,
  };
}

function createExtensionApi() {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const pi = {
    appendEntry: vi.fn(),
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      handlers.set(event, handler);
    },
    registerCommand(
      name: string,
      spec: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      commands.set(name, spec.handler);
    },
    setSessionName: vi.fn(),
  };

  return { commands, handlers, pi };
}

function createRetitleContext(options: {
  availableModels: Array<{ provider: string; id: string }>;
  currentModel: { provider: string; id: string };
  hasUI?: boolean;
}) {
  const entries = [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-03-23T00:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "Implement session auto-title" }],
        timestamp: 1,
      },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-03-23T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        timestamp: 2,
      },
    },
  ];

  return {
    cwd: "/repo/app",
    hasUI: options.hasUI ?? false,
    model: options.currentModel,
    modelRegistry: createFakeModelRegistry({ available: options.availableModels }),
    sessionManager: {
      getBranch() {
        return entries;
      },
      getEntries() {
        return entries;
      },
      getLeafId() {
        return "assistant-1";
      },
      getSessionFile() {
        return "/tmp/session.jsonl";
      },
      getSessionName() {
        return undefined;
      },
    },
    ui: {
      notify: vi.fn(),
    },
    waitForIdle: vi.fn(async () => {}),
  };
}
