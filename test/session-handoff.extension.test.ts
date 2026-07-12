import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHandoffBootstrap,
  createHandoffSessionMetadata,
  encodeHandoffBootstrap,
  HANDOFF_BOOTSTRAP_ENV,
  HANDOFF_STALE_SESSION_MESSAGE,
} from "../extensions/session-handoff/metadata.ts";

const mockLoadSettings = vi.fn();
const mockOpenSessionReferencePicker = vi.fn();
const mockIsGhosttyHandoffAvailable = vi.fn(() => true);
const mockCreateGhosttyLaunchBackend = vi.fn();
const mockCreateDetachedLaunchBackend = vi.fn();
const mockDetachedLaunch = vi.fn();
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
  validateSplitHandoffPrerequisites: vi.fn(),
}));

vi.mock("../extensions/session-handoff/launch/detached.ts", () => ({
  createDetachedLaunchBackend: mockCreateDetachedLaunchBackend,
}));

vi.mock("../extensions/session-handoff/spawn.ts", () => ({
  prepareHandoffLaunch: mockPrepareHandoffLaunch,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  delete process.env[HANDOFF_BOOTSTRAP_ENV];

  mockLoadSettings.mockReturnValue({
    handoff: { pickerShortcut: "alt+o", detached: { copyToClipboard: true } },
    index: { path: "/tmp/pi-sessions/index.sqlite" },
    autoTitle: { refreshTurns: 4, model: undefined, prompt: "Default auto-title prompt" },
  });
  mockOpenSessionReferencePicker.mockResolvedValue({ kind: "cancel" });
  mockIsGhosttyHandoffAvailable.mockReturnValue(true);
  mockDetachedLaunch.mockImplementation(async (input: { resumeCommand: string }) => ({
    success: true,
    message: input.resumeCommand,
  }));
  mockCreateDetachedLaunchBackend.mockReturnValue({ launch: mockDetachedLaunch });
  mockPrepareHandoffLaunch.mockImplementation((options: { model?: string }) => ({
    sessionId: "child-session-999",
    resumeCommand: `RESUME child-session-999 ${options.model ?? "inherit"}`,
  }));
});

describe("session handoff extension", () => {
  it("registers the picker shortcut and keeps the session token system prompt note", async () => {
    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
    const registerCommand = vi.fn();
    const pi = createPiApi(handlers, shortcuts, registerCommand);

    sessionHandoffExtension(pi as never);

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

    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.ts");
    const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
    const pi = createPiApi(new Map(), shortcuts, vi.fn());

    sessionHandoffExtension(pi as never);

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

    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.ts");
    const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
    const pi = createPiApi(new Map(), shortcuts, vi.fn());

    sessionHandoffExtension(pi as never);

    expect(shortcuts.has("alt+p")).toBe(true);
    expect(shortcuts.has("alt+o")).toBe(false);
  });

  it("does nothing when the picker is cancelled", async () => {
    mockOpenSessionReferencePicker.mockResolvedValue({ kind: "cancel" });

    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.ts");
    const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
    const pi = createPiApi(new Map(), shortcuts, vi.fn());

    sessionHandoffExtension(pi as never);

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
    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());

    sessionHandoffExtension(pi as never);

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
    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());

    sessionHandoffExtension(pi as never);
    const registerTool = pi.registerTool as ReturnType<typeof vi.fn>;
    expect(registerTool).not.toHaveBeenCalled();

    await handlers.get("session_start")?.(
      {},
      createSessionStartContext({ sessionId: "x" }) as never,
    );
    expect(launchValues(registerTool.mock.calls.at(-1)?.[0])).toEqual([
      "left",
      "right",
      "up",
      "down",
      "detached",
    ]);
  });

  it("offers only detached at session start when Ghostty is unavailable", async () => {
    mockIsGhosttyHandoffAvailable.mockReturnValue(false);
    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());

    sessionHandoffExtension(pi as never);
    await handlers.get("session_start")?.(
      {},
      createSessionStartContext({ sessionId: "x" }) as never,
    );

    const registerTool = pi.registerTool as ReturnType<typeof vi.fn>;
    expect(launchValues(registerTool.mock.calls.at(-1)?.[0])).toEqual(["detached"]);
  });

  it("runs a detached handoff, copies the resume command, and reports it", async () => {
    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());
    sessionHandoffExtension(pi as never);

    const result = await runTool(pi, handlers, { goal: "Do it", launch: "detached" });

    expect(mockCreateDetachedLaunchBackend).toHaveBeenCalledWith({ copyToClipboard: true });
    expect(mockCreateGhosttyLaunchBackend).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      launch: "detached",
      resumeCommand: "RESUME child-session-999 openai/gpt-5.4",
    });
    expect(result.content[0]?.text).toContain("RESUME child-session-999 openai/gpt-5.4");
  });

  it("degrades a split launch to detached when Ghostty is unavailable", async () => {
    mockIsGhosttyHandoffAvailable.mockReturnValue(false);
    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());
    sessionHandoffExtension(pi as never);

    const result = await runTool(pi, handlers, { goal: "Do it", launch: "right" });

    expect(mockCreateDetachedLaunchBackend).toHaveBeenCalled();
    expect(mockCreateGhosttyLaunchBackend).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ launch: "detached", degradedFrom: "right" });
  });

  it("rejects an unknown model override with the available list", async () => {
    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());
    sessionHandoffExtension(pi as never);

    await expect(
      runTool(
        pi,
        handlers,
        { goal: "Do it", launch: "detached", model: "ghost/model" },
        { availableModels: [{ provider: "openai", id: "gpt-5.4" }] },
      ),
    ).rejects.toThrow('Unknown model "ghost/model". Available models: openai/gpt-5.4.');
  });

  it("materializes handoff metadata and sends the initial prompt on matching child session start", async () => {
    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());

    sessionHandoffExtension(pi as never);

    process.env[HANDOFF_BOOTSTRAP_ENV] = encodeHandoffBootstrap(
      createHandoffBootstrap(
        "child-session-123",
        createHandoffSessionMetadata(
          "Finish phase 1",
          "Implement autocomplete",
          "Approved handoff draft",
          "Implement autocomplete",
        ),
      ),
    );

    const ctx = createSessionStartContext({ sessionId: "child-session-123" });
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
    expect(pi.sendUserMessage).toHaveBeenCalledWith("Approved handoff draft");
    expect(process.env[HANDOFF_BOOTSTRAP_ENV]).toBeUndefined();
  });

  it("refuses bootstrap when the target session already has user input", async () => {
    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());

    sessionHandoffExtension(pi as never);

    process.env[HANDOFF_BOOTSTRAP_ENV] = encodeHandoffBootstrap(
      createHandoffBootstrap(
        "child-session-123",
        createHandoffSessionMetadata(
          "Finish phase 1",
          "Implement autocomplete",
          "Approved handoff draft",
          "Implement autocomplete",
        ),
      ),
    );

    const ctx = createSessionStartContext({
      sessionId: "child-session-123",
      entries: [
        {
          type: "message",
          id: "user-1",
          parentId: null,
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
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(process.env[HANDOFF_BOOTSTRAP_ENV]).toBeUndefined();
  });

  it("still sends the prompt when metadata already exists but there is no user input", async () => {
    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.ts");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = createPiApi(handlers, new Map(), vi.fn());

    sessionHandoffExtension(pi as never);

    process.env[HANDOFF_BOOTSTRAP_ENV] = encodeHandoffBootstrap(
      createHandoffBootstrap(
        "child-session-123",
        createHandoffSessionMetadata(
          "Finish phase 1",
          "Implement autocomplete",
          "Approved handoff draft",
          "Implement autocomplete",
        ),
      ),
    );

    const ctx = createSessionStartContext({
      sessionId: "child-session-123",
      entries: [
        {
          type: "custom",
          id: "custom-1",
          parentId: null,
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
    expect(pi.sendUserMessage).toHaveBeenCalledWith("Approved handoff draft");
    expect(process.env[HANDOFF_BOOTSTRAP_ENV]).toBeUndefined();
  });
});

function createPiApi(
  handlers: Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>,
  shortcuts: Map<string, { handler: (ctx: unknown) => Promise<void> }>,
  registerCommand: ReturnType<typeof vi.fn>,
) {
  return {
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
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
    modelRegistry: {
      getAvailable: () => options?.availableModels ?? [],
    },
    sessionManager: {
      getSessionFile: () => "/tmp/parent.jsonl",
      getSessionDir: () => "/tmp/sessions",
      getLeafId: () => "user-1",
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
      ],
    },
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
    modelRegistry: {
      getAvailable: () => options.availableModels ?? [],
    },
    sessionManager: {
      getSessionId() {
        return options.sessionId;
      },
      getEntries() {
        return options.entries ?? [];
      },
      getSessionName() {
        return undefined;
      },
      appendCustomEntry: vi.fn(),
    },
  };
}
