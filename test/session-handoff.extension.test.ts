import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChildGeneratedHandoffBootstrap,
  HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
} from "../extensions/session-handoff/metadata.ts";
import { parseModelSelection } from "../extensions/shared/model.ts";
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
  formatHandoffLaunchFailure: (
    error: string,
    prepared: { sessionId: string; resumeCommand: string },
  ) =>
    `${error} Created handoff session ${prepared.sessionId}; start it manually with: ${prepared.resumeCommand}`,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  mockLoadSettings.mockReturnValue({
    handoff: {
      pickerShortcut: "alt+o",
      persistRuns: false,
      roster: [],
      deferred: { copyToClipboard: true },
    },
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
    backend: "deferred",
    clipboardStatus: "copied",
  }));
  mockCreateDeferredLaunchBackend.mockReturnValue({ launch: mockDeferredLaunch });
  mockPrepareHandoffLaunch.mockImplementation((options: { model?: string }) => ({
    sessionId: "child-session-999",
    sessionFile: "/tmp/child-session-999.jsonl",
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
      expect.objectContaining({ description: "Open the handoff board" }),
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
      handoff: {
        pickerShortcut: "alt+p",
        persistRuns: false,
        roster: [],
        deferred: { copyToClipboard: true },
      },
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

  it("re-registers the tool with available models in the prompt guidelines on session start", async () => {
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
    const lastDefinition = registerTool.mock.calls.at(-1)?.[0];
    const guidelines = promptGuidelines(lastDefinition).join("\n");
    expect(guidelines).toContain("openai/gpt-5.4");
    expect(guidelines).toContain("anthropic/claude-sonnet-4-5");
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
    const definition = registerTool.mock.calls.at(-1)?.[0];
    expect(launchValues(definition)).toEqual(["deferred"]);
    expect(promptGuidelines(definition)).toEqual([
      "Use session_handoff directional or deferred launches only when the user requests one.",
      "Leave provider and model unset to run the handoff on this session's current model.",
      "To run the handoff on a different model, set both provider and model together (both are required).",
      "Only override the model when the task clearly warrants it.",
    ]);
  });

  it("offers an injected subagent target and defaults its response request to true", async () => {
    const launch = vi.fn().mockResolvedValue({ success: true, backend: "tmux" });
    const target = {
      value: "subagent" as const,
      description: "Detached subagent launch.",
      requestResponseDefault: true,
      bootstrapMode: "automatic" as const,
      describeSubagentChild: (input: {
        childSessionId: string;
        ownerSessionId: string;
        requestResponse: boolean;
      }) => ({
        childSessionId: input.childSessionId,
        ownerSessionId: input.ownerSessionId,
        depth: 1,
        requestResponse: input.requestResponse,
      }),
      approveProjectTrust: true,
      prepareChild: vi.fn(),
      launch,
    };
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());
    installHandoffAndWire(installHandoff, pi, [target]);

    const result = await runTool(pi, handlers, {
      goal: "Investigate it",
      title: "Investigate",
      launch: "subagent",
    });

    const definition = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(launchValues(definition)).toContain("subagent");
    expect(promptGuidelines(definition)).toContain(
      'Use session_handoff with launch: "subagent" for a concrete, bounded task that can proceed independently while useful work continues in the current session.',
    );
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ requestResponse: true }));
    const preparation = mockPrepareHandoffLaunch.mock.calls.at(-1)?.[0] as {
      buildBootstrap: (sessionId: string) => { launch: string; subagent: unknown };
    };
    const bootstrap = preparation.buildBootstrap("child-session-999");
    expect(bootstrap).toMatchObject({
      requestResponse: true,
      bootstrapMode: "automatic",
      launch: "subagent",
    });
    expect(bootstrap.subagent).toEqual({
      childSessionId: "child-session-999",
      ownerSessionId: "tool-session",
      depth: 1,
      requestResponse: true,
    });
    expect(result.details).toMatchObject({ launch: "subagent", backend: "tmux" });
    expect(result.content[0]?.text).toContain('"requestResponse": true');
  });

  it("rejects overlong titles before preparing a child session", async () => {
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());
    installHandoffAndWire(installHandoff, pi);

    await expect(
      runTool(pi, handlers, {
        goal: "Investigate it",
        title: "x".repeat(65),
        launch: "deferred",
      }),
    ).rejects.toThrow("session_handoff title must be 64 characters or less.");

    const definition = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(titleMaxLength(definition)).toBe(64);
    expect(mockPrepareHandoffLaunch).not.toHaveBeenCalled();
  });

  it("accepts a schema-valid 64-code-point astral title", async () => {
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());
    installHandoffAndWire(installHandoff, pi);

    await expect(
      runTool(pi, handlers, {
        goal: "Investigate it",
        title: "😀".repeat(64),
        launch: "deferred",
      }),
    ).resolves.toMatchObject({ details: { sessionId: "child-session-999" } });

    expect(mockPrepareHandoffLaunch).toHaveBeenCalledOnce();
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
      bootstrapMode: "review",
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
    const mockTmuxLaunch = vi.fn().mockResolvedValue({ success: true, backend: "tmux" });
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
        {
          goal: "Do it",
          title: "Do it now",
          launch: "deferred",
          provider: "ghost",
          model: "model",
        },
        { availableModels: [{ provider: "openai", id: "gpt-5.4" }] },
      ),
    ).rejects.toThrow('Model "ghost/model" not found. Available models: openai/gpt-5.4.');
  });

  it("falls back to the session's scoped models when no roster is configured", async () => {
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());
    installHandoffAndWire(installHandoff, pi);

    const availableModels = [
      { provider: "openai", id: "gpt-5.4" },
      { provider: "metered", id: "gpt-5.4" },
    ];
    const scopedModels = [{ model: availableModels[0], thinkingLevel: "high" }];

    await expect(
      runTool(
        pi,
        handlers,
        {
          goal: "Do it",
          title: "Do it now",
          launch: "deferred",
          provider: "metered",
          model: "gpt-5.4",
        },
        { availableModels, scopedModels },
      ),
    ).rejects.toThrow(
      'Model "metered/gpt-5.4" is not on the handoff roster. Allowed models: openai/gpt-5.4:high.',
    );

    const registerTool = pi.registerTool as ReturnType<typeof vi.fn>;
    expect(promptGuidelines(registerTool.mock.calls.at(-1)?.[0])).toContain(
      "Available models, given as provider/model-id: openai/gpt-5.4:high.",
    );
  });

  it("restricts the advertised and accepted models to a configured roster", async () => {
    mockLoadSettings.mockReturnValue({
      features: {},
      subagents: { maxDepth: 2 },
      handoff: {
        pickerShortcut: "alt+o",
        persistRuns: false,
        roster: [parseModelSelection("openai/*")],
        deferred: { copyToClipboard: true },
      },
      index: { path: "/tmp/pi-sessions/index.sqlite" },
      autoTitle: { refreshTurns: 4, model: undefined, prompt: "Default auto-title prompt" },
    });
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());
    installHandoffAndWire(installHandoff, pi);

    const availableModels = [
      { provider: "openai", id: "gpt-5.4" },
      { provider: "metered", id: "gpt-5.4" },
    ];

    await expect(
      runTool(
        pi,
        handlers,
        {
          goal: "Do it",
          title: "Do it now",
          launch: "deferred",
          provider: "metered",
          model: "gpt-5.4",
        },
        { availableModels, scopedModels: [{ model: availableModels[1] }] },
      ),
    ).rejects.toThrow(
      'Model "metered/gpt-5.4" is not on the handoff roster. Allowed models: openai/gpt-5.4.',
    );

    const registerTool = pi.registerTool as ReturnType<typeof vi.fn>;
    const definition = registerTool.mock.calls.at(-1)?.[0];
    expect(promptGuidelines(definition)).toContain(
      "Available models, given as provider/model-id: openai/gpt-5.4.",
    );
  });

  it("shuts down an automatic child when bootstrap fails before its first turn", async () => {
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());
    installHandoffAndWire(installHandoff, pi);

    const ctx = createSessionStartContext({
      sessionId: "child-session-123",
      entries: [pendingGeneratedBootstrapEntry("automatic")],
    });
    ctx.ui.custom = vi.fn(async () => {
      throw new Error("bootstrap failed");
    });
    await handlers.get("session_start")?.({}, ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith("bootstrap failed", "error");
    expect(ctx.shutdown).toHaveBeenCalledOnce();
  });

  it("leaves reviewed handoffs open when bootstrap fails", async () => {
    const { installHandoff } = await import("../extensions/session-handoff/install.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());
    installHandoffAndWire(installHandoff, pi);

    const ctx = createSessionStartContext({
      sessionId: "child-session-123",
      entries: [pendingGeneratedBootstrapEntry("review")],
    });
    ctx.ui.custom = vi.fn(async () => {
      throw new Error("bootstrap failed");
    });
    await handlers.get("session_start")?.({}, ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith("bootstrap failed", "error");
    expect(ctx.shutdown).not.toHaveBeenCalled();
  });
});

function installHandoffAndWire(
  installHandoff: typeof import("../extensions/session-handoff/install.ts").installHandoff,
  pi: ReturnType<typeof createPiApi>,
  additionalTargets: readonly import("../extensions/session-handoff/launch-target.ts").HandoffLaunchTarget[] = [],
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
    getLaunchTargets: () => additionalTargets,
    board: {},
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

function promptGuidelines(definition: unknown): string[] {
  return (definition as { promptGuidelines: string[] }).promptGuidelines;
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

function titleMaxLength(definition: unknown): number | undefined {
  return (definition as { parameters: { properties: { title: { maxLength?: number } } } })
    .parameters.properties.title.maxLength;
}

async function runTool(
  pi: ReturnType<typeof createPiApi>,
  handlers: Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>,
  params: Record<string, unknown>,
  options?: { availableModels?: unknown[]; scopedModels?: unknown[] },
): Promise<{
  content: Array<{ text?: string }>;
  details: Record<string, unknown>;
}> {
  await handlers.get("session_start")?.(
    {},
    createSessionStartContext({
      sessionId: "tool-session",
      ...(options?.availableModels ? { availableModels: options.availableModels } : {}),
      ...(options?.scopedModels ? { scopedModels: options.scopedModels } : {}),
    }) as never,
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
      getSessionId: () => "tool-session",
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

function pendingGeneratedBootstrapEntry(bootstrapMode: "review" | "automatic") {
  return {
    type: "custom",
    id: "bootstrap-1",
    parentId: null,
    timestamp: "2026-03-23T00:00:00.000Z",
    customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
    data: createChildGeneratedHandoffBootstrap({
      sessionId: "child-session-123",
      goal: "Finish phase 1",
      title: "Implement autocomplete",
      parentSessionFile: "/tmp/missing-parent.jsonl",
      sourceLeafId: "source-leaf",
      requestResponse: false,
      bootstrapMode,
      launch: "deferred",
    }),
  };
}

function createSessionStartContext(options: {
  sessionId: string;
  entries?: unknown[];
  availableModels?: unknown[];
  scopedModels?: unknown[];
}) {
  return {
    hasUI: true,
    scopedModels: options.scopedModels ?? [],
    ui: {
      notify: vi.fn(),
      custom: vi.fn(),
    },
    shutdown: vi.fn(),
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
