import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeSimpleMock, loadSettingsMock } = vi.hoisted(() => ({
  completeSimpleMock: vi.fn(),
  loadSettingsMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: completeSimpleMock,
}));

vi.mock("../extensions/shared/settings.ts", () => ({
  loadSettings: loadSettingsMock,
  ModelReference: class ModelReference {
    constructor(
      readonly provider: string,
      readonly modelId: string,
    ) {}

    toString() {
      return `${this.provider}/${this.modelId}`;
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  loadSettingsMock.mockReturnValue({
    autoTitle: {
      refreshTurns: 4,
      timeoutMs: 15_000,
      model: {
        provider: "google",
        modelId: "gemini-flash-lite-latest",
      },
      prompt: "Default auto-title prompt",
    },
  });
});

describe("session auto-title extension", () => {
  it("resolves the current session model at session start when cheap models are unavailable", async () => {
    const { default: sessionAutoTitleExtension } = await import(
      "../extensions/session-auto-title.ts"
    );
    const { commands, handlers, pi } = createExtensionApi();

    sessionAutoTitleExtension(pi as never);

    const sessionStart = handlers.get("session_start");
    const title = commands.get("title");
    expect(sessionStart).toBeDefined();
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

    await sessionStart?.({}, ctx as never);
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
        model: {
          provider: "google",
          modelId: "gemini-flash-lite-latest",
        },
        prompt: "Name sessions like terse incident reports.",
      },
    });
    const { default: sessionAutoTitleExtension } = await import(
      "../extensions/session-auto-title.ts"
    );
    const { commands, handlers, pi } = createExtensionApi();

    sessionAutoTitleExtension(pi as never);

    const sessionStart = handlers.get("session_start");
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

    await sessionStart?.({}, ctx as never);
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

    await generateAutoTitle(
      ctx as never,
      { provider: "openai", id: "gpt-5.4-mini" } as never,
      {
        cwd: "/repo/app",
        currentTitle: "Existing Title",
        conversationText: "user: keep working",
        userTurnCount: 5,
        assistantTurnCount: 4,
      },
      "manual",
      "Name this coding session.",
      15_000,
    );
    await generateAutoTitle(
      ctx as never,
      { provider: "openai", id: "gpt-5.4-mini" } as never,
      {
        cwd: "/repo/app",
        currentTitle: "Existing Title",
        conversationText: "user: keep working",
        userTurnCount: 5,
        assistantTurnCount: 4,
      },
      "periodic",
      "Name this coding session.",
      15_000,
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

  it("does not retry a second model after startup picks one resolved model", async () => {
    const { default: sessionAutoTitleExtension } = await import(
      "../extensions/session-auto-title.ts"
    );
    const { commands, handlers, pi } = createExtensionApi();

    sessionAutoTitleExtension(pi as never);

    const sessionStart = handlers.get("session_start");
    const title = commands.get("title");
    expect(sessionStart).toBeDefined();
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

    await sessionStart?.({}, ctx as never);
    await title?.("", ctx as never);

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(completeSimpleMock.mock.calls[0]?.[0]).toEqual(configuredModel);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Session retitle failed.", "error");
  });

  it("surfaces background auto-title failures as a warning notification", async () => {
    const { default: sessionAutoTitleExtension } = await import(
      "../extensions/session-auto-title.ts"
    );
    const { handlers, pi } = createExtensionApi();

    sessionAutoTitleExtension(pi as never);

    const sessionStart = handlers.get("session_start");
    const turnEnd = handlers.get("turn_end");
    expect(sessionStart).toBeDefined();
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

    await sessionStart?.({}, ctx as never);
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
    modelRegistry: {
      getAvailable() {
        return options.availableModels;
      },
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "test-key", headers: undefined };
      },
    },
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
