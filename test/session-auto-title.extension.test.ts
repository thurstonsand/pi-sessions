import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeSimpleMock, loadSettingsMock } = vi.hoisted(() => ({
  completeSimpleMock: vi.fn(),
  loadSettingsMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<object>("@mariozechner/pi-ai");
  return {
    ...actual,
    completeSimple: completeSimpleMock,
  };
});

vi.mock("../extensions/shared/settings.js", () => ({
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
      model: {
        provider: "google",
        modelId: "gemini-flash-lite-latest",
      },
    },
  });
});

describe("session auto-title extension", () => {
  it("resolves the current session model at session start when cheap models are unavailable", async () => {
    const { default: sessionAutoTitleExtension } = await import(
      "../extensions/session-auto-title.js"
    );
    const { commands, handlers, pi } = createExtensionApi();

    sessionAutoTitleExtension(pi as never);

    const sessionStart = handlers.get("session_start");
    const retitle = commands.get("retitle");
    expect(sessionStart).toBeDefined();
    expect(retitle).toBeDefined();

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
    await retitle?.("", ctx as never);

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(completeSimpleMock.mock.calls[0]?.[0]).toEqual(currentModel);
    expect(pi.setSessionName).toHaveBeenCalledWith("Resolved Title");
  });

  it("does not retry a second model after startup picks one resolved model", async () => {
    const { default: sessionAutoTitleExtension } = await import(
      "../extensions/session-auto-title.js"
    );
    const { commands, handlers, pi } = createExtensionApi();

    sessionAutoTitleExtension(pi as never);

    const sessionStart = handlers.get("session_start");
    const retitle = commands.get("retitle");
    expect(sessionStart).toBeDefined();
    expect(retitle).toBeDefined();

    const configuredModel = { provider: "google", id: "gemini-flash-lite-latest" };
    const currentModel = { provider: "openai", id: "gpt-5.4-mini" };
    const ctx = createRetitleContext({
      availableModels: [configuredModel],
      currentModel,
    });
    completeSimpleMock.mockResolvedValue({
      stopReason: "error",
      content: [],
    });

    await sessionStart?.({}, ctx as never);
    await retitle?.("", ctx as never);

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(completeSimpleMock.mock.calls[0]?.[0]).toEqual(configuredModel);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Session retitle failed.", "error");
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
    hasUI: false,
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
