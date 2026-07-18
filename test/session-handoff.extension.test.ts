import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHandoffBootstrap,
  createHandoffSessionMetadata,
  HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
  HANDOFF_STALE_SESSION_MESSAGE,
} from "../extensions/session-handoff/metadata.ts";
import { createFakeModelRegistry, createFakeModelRuntime } from "./test-helpers.ts";

const mockLoadSettings = vi.fn();
const mockOpenSessionReferencePicker = vi.fn();
const mockIsGhosttyHandoffAvailable = vi.fn(() => true);
const mockCreateGhosttyLaunchBackend = vi.fn();
const mockCreateTmuxSplitLaunchBackend = vi.fn();
const mockResolveSplitLaunchBackend = vi.fn();
const mockCreateDeferredLaunchBackend = vi.fn();
const mockDeferredLaunch = vi.fn();
const mockPrepareHandoffLaunch = vi.fn();

vi.mock("../extensions/shared/settings.ts", () => ({
  loadSettings: mockLoadSettings,
}));

vi.mock("../extensions/session-handoff/picker.ts", () => ({
  openSessionReferencePicker: mockOpenSessionReferencePicker,
}));

vi.mock("../extensions/session-handoff/launch/ghostty.ts", () => ({
  isGhosttyHandoffAvailable: mockIsGhosttyHandoffAvailable,
  getFocusedGhosttyTerminalId: vi.fn(),
  createGhosttyLaunchBackend: mockCreateGhosttyLaunchBackend,
}));

vi.mock("../extensions/session-handoff/launch/resolution.ts", () => ({
  resolveSplitLaunchBackend: mockResolveSplitLaunchBackend,
  validateSplitHandoffPrerequisites: vi.fn(),
}));

vi.mock("../extensions/session-handoff/launch/tmux.ts", () => ({
  createTmuxSplitLaunchBackend: mockCreateTmuxSplitLaunchBackend,
}));

vi.mock("../extensions/session-handoff/launch/deferred.ts", () => ({
  createDeferredLaunchBackend: mockCreateDeferredLaunchBackend,
}));

vi.mock("../extensions/session-handoff/spawn.ts", () => ({
  prepareHandoffLaunch: mockPrepareHandoffLaunch,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  mockLoadSettings.mockReturnValue({
    handoff: { pickerShortcut: "alt+o", deferred: { copyToClipboard: true } },
    index: { path: "/tmp/pi-sessions/index.sqlite" },
    autoTitle: { refreshTurns: 4, model: undefined, prompt: "Default auto-title prompt" },
  });
  mockOpenSessionReferencePicker.mockResolvedValue({ kind: "cancel" });
  mockIsGhosttyHandoffAvailable.mockReturnValue(true);
  mockResolveSplitLaunchBackend.mockImplementation(
    (pi: unknown, options: { getTerminalId: () => string | undefined }) => ({
      name: "Ghostty",
      create: (direction: string) =>
        mockCreateGhosttyLaunchBackend(pi, {
          direction,
          terminalId: options.getTerminalId(),
        }),
    }),
  );
  mockDeferredLaunch.mockImplementation(async () => ({
    success: true,
    clipboardStatus: "copied",
  }));
  mockCreateDeferredLaunchBackend.mockReturnValue({ launch: mockDeferredLaunch });
  mockPrepareHandoffLaunch.mockImplementation((options: { model?: string }) => ({
    sessionId: "child-session-999",
    resumeCommand: `RESUME child-session-999 ${options.model ?? "inherit"}`,
  }));
});

describe("session handoff extension", () => {
  it("registers the picker shortcut and keeps the session token system prompt note", async () => {
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
    const registerCommand = vi.fn();
    const pi = createPiApi(handlers, shortcuts, registerCommand);

    installHandoffAndWire(installHandoff, pi);

    expect(registerCommand).toHaveBeenCalledWith(
      "handoff",
      expect.objectContaining({ description: "Transfer context to a new focused session" }),
    );
    expect(shortcuts.has("alt+o")).toBe(true);

    const beforeAgentStartHandler = handlers.get("before_agent_start");
    await expect(beforeAgentStartHandler?.({ systemPrompt: "Base prompt" })).resolves.toEqual({
      systemPrompt:
        "Base prompt\n\nWhen the user references @session:<uuid>, treat it as a session token. If you call session_ask, pass only the UUID value, not the @session: prefix.",
    });
  });

  it("opens the picker from alt+o and pastes the canonical token", async () => {
    mockOpenSessionReferencePicker.mockResolvedValue({
      kind: "insert-session-token",
      sessionId: "88171ce4-9021-4464-8cab-f49d04a82815",
    });

    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
    const pi = createPiApi(new Map(), shortcuts, vi.fn());

    installHandoffAndWire(installHandoff, pi);

    const pasteToEditor = vi.fn();
    await shortcuts.get("alt+o")?.handler({
      mode: "tui",
      hasUI: true,
      cwd: "/repo/app",
      ui: { pasteToEditor },
      sessionManager: { getSessionFile: () => "/tmp/current.jsonl" },
    });

    expect(mockOpenSessionReferencePicker).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo/app" }),
      "/tmp/pi-sessions/index.sqlite",
      "alt+o",
    );
    expect(pasteToEditor).toHaveBeenCalledWith("@session:88171ce4-9021-4464-8cab-f49d04a82815");
  });

  it("respects a custom picker shortcut", async () => {
    mockLoadSettings.mockReturnValue({
      handoff: { pickerShortcut: "alt+p" },
      index: { path: "/tmp/pi-sessions/index.sqlite" },
      autoTitle: { refreshTurns: 4, model: undefined, prompt: "Default auto-title prompt" },
    });

    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
    const pi = createPiApi(new Map(), shortcuts, vi.fn());

    installHandoffAndWire(installHandoff, pi);

    expect(shortcuts.has("alt+p")).toBe(true);
    expect(shortcuts.has("alt+o")).toBe(false);
  });

  it("does nothing when the picker is cancelled", async () => {
    mockOpenSessionReferencePicker.mockResolvedValue({ kind: "cancel" });

    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
    const pi = createPiApi(new Map(), shortcuts, vi.fn());

    installHandoffAndWire(installHandoff, pi);

    const pasteToEditor = vi.fn();
    await shortcuts.get("alt+o")?.handler({
      mode: "tui",
      hasUI: true,
      cwd: "/repo/app",
      ui: { pasteToEditor },
      sessionManager: { getSessionFile: () => "/tmp/current.jsonl" },
    });

    expect(pasteToEditor).not.toHaveBeenCalled();
  });

  it("re-registers the tool with available models in the model description on session start", async () => {
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());

    installHandoffAndWire(installHandoff, pi);

    const ctx = createSessionStartContext({
      sessionId: "child-session-123",
      availableModels: [
        { provider: "openai", id: "gpt-5.4" },
        { provider: "anthropic", id: "claude-sonnet-4-5" },
      ],
    });
    await handlers.get("session_start")?.({}, ctx as never);

    const registerTool = pi.registerTool as ReturnType<typeof vi.fn>;
    const lastDefinition = registerTool.mock.calls.at(-1)?.[0] as {
      parameters: { properties: { model: { description: string } } };
    };
    const modelDescription = lastDefinition.parameters.properties.model.description;
    expect(modelDescription).toContain("openai/gpt-5.4");
    expect(modelDescription).toContain("anthropic/claude-sonnet-4-5");
  });

  it("registers only at session start, adding split directions when Ghostty is present", async () => {
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());

    installHandoffAndWire(installHandoff, pi);
    const registerTool = pi.registerTool as ReturnType<typeof vi.fn>;
    expect(registerTool).not.toHaveBeenCalled();

    await handlers.get("session_start")?.(
      {},
      createSessionStartContext({ sessionId: "x" }) as never,
    );
    const definition = registerTool.mock.calls.at(-1)?.[0];
    expect(launchValues(definition)).toEqual(["left", "right", "up", "down", "deferred"]);
    expect(launchDescription(definition)).toContain("direction values open a Ghostty split");
  });

  it("describes tmux when tmux is the selected split backend", async () => {
    mockResolveSplitLaunchBackend.mockReturnValue({ name: "tmux", create: vi.fn() });
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());

    installHandoffAndWire(installHandoff, pi);
    await handlers.get("session_start")?.(
      {},
      createSessionStartContext({ sessionId: "x" }) as never,
    );

    const registerTool = pi.registerTool as ReturnType<typeof vi.fn>;
    expect(launchDescription(registerTool.mock.calls.at(-1)?.[0])).toContain(
      "direction values open a tmux split",
    );
  });

  it("offers only deferred at session start when no split backend is available", async () => {
    mockIsGhosttyHandoffAvailable.mockReturnValue(false);
    mockResolveSplitLaunchBackend.mockReturnValue(undefined);
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());

    installHandoffAndWire(installHandoff, pi);
    await handlers.get("session_start")?.(
      {},
      createSessionStartContext({ sessionId: "x" }) as never,
    );

    const registerTool = pi.registerTool as ReturnType<typeof vi.fn>;
    expect(launchValues(registerTool.mock.calls.at(-1)?.[0])).toEqual(["deferred"]);
  });

  it("runs a deferred handoff, copies the resume command, and reports it", async () => {
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());
    installHandoffAndWire(installHandoff, pi);

    const result = await runTool(pi, handlers, {
      goal: "Do it",
      title: "Do it now",
      launch: "deferred",
    });

    expect(mockCreateDeferredLaunchBackend).toHaveBeenCalledWith({ copyToClipboard: true });
    expect(mockCreateGhosttyLaunchBackend).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      launch: "deferred",
      resumeCommand: "RESUME child-session-999 openai/gpt-5.4",
    });
    expect(result.content[0]?.text).toContain("RESUME child-session-999 openai/gpt-5.4");

    const launchOptions = mockPrepareHandoffLaunch.mock.calls.at(-1)?.[0] as {
      buildBootstrap: (sessionId: string) => unknown;
    };
    expect(launchOptions.buildBootstrap("child-session-999")).toMatchObject({
      sourceLeafId: "user-1",
    });
  });

  it("degrades a split launch to deferred when no split backend is available", async () => {
    mockIsGhosttyHandoffAvailable.mockReturnValue(false);
    mockResolveSplitLaunchBackend.mockReturnValue(undefined);
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());
    installHandoffAndWire(installHandoff, pi);

    const result = await runTool(pi, handlers, {
      goal: "Do it",
      title: "Do it now",
      launch: "right",
    });

    expect(mockCreateDeferredLaunchBackend).toHaveBeenCalled();
    expect(mockCreateGhosttyLaunchBackend).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ launch: "deferred", degradedFrom: "right" });
  });

  it("routes tool splits through tmux before Ghostty", async () => {
    const mockTmuxLaunch = vi.fn().mockResolvedValue({ success: true });
    mockResolveSplitLaunchBackend.mockImplementation((pi: unknown) => ({
      name: "tmux",
      create: (direction: string) => mockCreateTmuxSplitLaunchBackend(pi, direction),
    }));
    mockCreateTmuxSplitLaunchBackend.mockReturnValue({ name: "tmux", launch: mockTmuxLaunch });
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());
    installHandoffAndWire(installHandoff, pi);

    const result = await runTool(pi, handlers, {
      goal: "Do it",
      title: "Do it now",
      launch: "right",
    });

    expect(mockCreateTmuxSplitLaunchBackend).toHaveBeenCalledWith(pi, "right");
    expect(mockCreateGhosttyLaunchBackend).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ launch: "right", backend: "tmux" });
  });

  it("rejects an unknown model override with the available list", async () => {
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());
    installHandoffAndWire(installHandoff, pi);

    await expect(
      runTool(
        pi,
        handlers,
        { goal: "Do it", title: "Do it now", launch: "deferred", model: "ghost/model" },
        { availableModels: [{ provider: "openai", id: "gpt-5.4" }] },
      ),
    ).rejects.toThrow('Model "ghost/model" not found. Available models: openai/gpt-5.4.');
  });

  it("materializes handoff metadata and sends the initial prompt on matching child session start", async () => {
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());

    installHandoffAndWire(installHandoff, pi);

    const ctx = createSessionStartContext({
      sessionId: "child-session-123",
      entries: [pendingBootstrapEntry()],
    });
    await handlers.get("session_start")?.({}, ctx as never);

    expect(pi.appendEntry).toHaveBeenCalledWith(
      "pi-sessions.handoff",
      expect.objectContaining({
        origin: "handoff",
        goal: "Finish phase 1",
        nextTask: "Implement autocomplete",
        title: "Implement autocomplete",
        initial_prompt: "Approved handoff draft",
      }),
    );
    expect(pi.setSessionName).toHaveBeenCalledWith("Implement autocomplete");
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "pi-sessions.handoff-kickoff",
        content: "Approved handoff draft",
        details: expect.objectContaining({
          title: "Implement autocomplete",
          source: { sessionId: "parent-session-1", sessionName: "Parent Session" },
          bootstrapEntryId: "bootstrap-1",
        }),
      }),
      { triggerTurn: true },
    );
  });

  it("refuses bootstrap when the target session already has user input", async () => {
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());

    installHandoffAndWire(installHandoff, pi);

    const ctx = createSessionStartContext({
      sessionId: "child-session-123",
      entries: [
        pendingBootstrapEntry(),
        {
          type: "message",
          id: "user-1",
          parentId: "bootstrap-1",
          timestamp: "2026-03-23T00:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "Already typing here." }],
            timestamp: 1,
          },
        },
      ],
    });
    await handlers.get("session_start")?.({}, ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith(HANDOFF_STALE_SESSION_MESSAGE, "error");
    expect(pi.appendEntry).toHaveBeenCalledWith("pi-sessions.handoff-bootstrap-consumed", {
      bootstrapEntryId: "bootstrap-1",
      reason: "stale",
    });
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("still sends the prompt when metadata already exists but there is no user input", async () => {
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());

    installHandoffAndWire(installHandoff, pi);

    const ctx = createSessionStartContext({
      sessionId: "child-session-123",
      entries: [
        pendingBootstrapEntry(),
        {
          type: "custom",
          id: "custom-1",
          parentId: "bootstrap-1",
          timestamp: "2026-03-23T00:00:00.000Z",
          customType: "pi-sessions.handoff",
          data: createHandoffSessionMetadata(
            "Finish phase 1",
            "Implement autocomplete",
            "Approved handoff draft",
            "Implement autocomplete",
          ),
        },
      ],
    });
    await handlers.get("session_start")?.({}, ctx as never);

    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Approved handoff draft" }),
      { triggerTurn: true },
    );
  });
});

function installHandoffAndWire(
  installHandoff: typeof import("../extensions/session-handoff/install.ts").installHandoff,
  pi: ReturnType<typeof createPiApi>,
): void {
  const settings = mockLoadSettings() as { index: { path: string } };
  const lifecycle = installHandoff(pi as never, {
    settings: settings as never,
    index: { path: settings.index.path },
    getModelRuntime: async (modelRegistry) =>
      createFakeModelRuntime({
        all: modelRegistry.getAll(),
        available: modelRegistry.getAvailable(),
      }) as never,
  });
  if (lifecycle.onSessionStart) {
    pi.on("session_start", lifecycle.onSessionStart as never);
  }
}

function createPiApi(
  handlers: Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>,
  shortcuts: Map<string, { handler: (ctx: unknown) => Promise<void> }>,
  registerCommand: ReturnType<typeof vi.fn>,
) {
  return {
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    setSessionName: vi.fn(),
    getThinkingLevel: vi.fn(),
    registerCommand,
    registerTool: vi.fn(),
    registerShortcut: vi.fn(
      (shortcut: string, definition: { handler: (ctx: unknown) => Promise<void> }) => {
        shortcuts.set(shortcut, definition);
      },
    ),
    events: { emit: vi.fn(), on: vi.fn() },
    on(event: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown>) {
      handlers.set(event, handler);
    },
  };
}

function launchDescription(definition: unknown): string {
  return (definition as { parameters: { properties: { launch: { description: string } } } })
    .parameters.properties.launch.description;
}

function launchValues(definition: unknown): string[] {
  const parameters = (
    definition as { parameters: { properties: { launch: { anyOf: unknown[] } } } }
  ).parameters;
  return parameters.properties.launch.anyOf.map((schema) => (schema as { const: string }).const);
}

async function runTool(
  pi: ReturnType<typeof createPiApi>,
  handlers: Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>,
  params: Record<string, unknown>,
  options?: { availableModels?: unknown[] },
): Promise<{
  content: Array<{ text?: string }>;
  details: Record<string, unknown>;
}> {
  await handlers.get("session_start")?.(
    {},
    createSessionStartContext({ sessionId: "tool-session" }) as never,
  );
  const registerTool = pi.registerTool as ReturnType<typeof vi.fn>;
  const definition = registerTool.mock.calls.at(-1)?.[0] as {
    execute: (...args: unknown[]) => Promise<unknown>;
  };
  const ctx = createToolExecuteContext(options);
  return definition.execute("call-1", params, undefined, () => {}, ctx) as never;
}

function createToolExecuteContext(options?: { availableModels?: unknown[] }) {
  return {
    cwd: process.cwd(),
    model: { provider: "openai", id: "gpt-5.4" },
    modelRegistry: createFakeModelRegistry({
      available: (options?.availableModels ?? []) as never,
    }),
    sessionManager: {
      getSessionFile: () => "/tmp/parent.jsonl",
      getSessionDir: () => "/tmp/sessions",
      getLeafId: () => "assistant-1",
      getEntry: (id: string) => {
        if (id === "assistant-1") {
          return { id: "assistant-1", parentId: "user-1" };
        }
        if (id === "user-1") {
          return { id: "user-1", parentId: null };
        }
        return undefined;
      },
      getEntries: () => [
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-03-23T00:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "Do the thing." }],
            timestamp: 1,
          },
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: "2026-03-23T00:00:01.000Z",
          message: {
            role: "assistant",
            content: [],
            timestamp: 2,
          },
        },
      ],
    },
  };
}

function pendingBootstrapEntry() {
  return {
    type: "custom",
    id: "bootstrap-1",
    parentId: null,
    timestamp: "2026-03-23T00:00:00.000Z",
    customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
    data: createHandoffBootstrap(
      "child-session-123",
      createHandoffSessionMetadata(
        "Finish phase 1",
        "Implement autocomplete",
        "Approved handoff draft",
        "Implement autocomplete",
      ),
      { sessionId: "parent-session-1", sessionName: "Parent Session" },
    ),
  };
}

function createSessionStartContext(options: {
  sessionId: string;
  entries?: unknown[];
  availableModels?: unknown[];
}) {
  return {
    hasUI: true,
    ui: {
      notify: vi.fn(),
    },
    modelRegistry: createFakeModelRegistry({
      available: (options.availableModels ?? []) as never,
    }),
    sessionManager: {
      getSessionId() {
        return options.sessionId;
      },
      getEntries() {
        return options.entries ?? [];
      },
      getBranch() {
        return options.entries ?? [];
      },
      getSessionName() {
        return undefined;
      },
      appendCustomEntry: vi.fn(),
    },
  };
}
