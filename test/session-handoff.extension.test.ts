import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadSettings = vi.fn();
const mockConnectPowerlineHandoffAutocomplete = vi.fn();

vi.mock("../extensions/shared/settings.js", () => ({
  loadSettings: mockLoadSettings,
}));

vi.mock("../extensions/session-handoff/powerline.js", () => ({
  connectPowerlineHandoffAutocomplete: mockConnectPowerlineHandoffAutocomplete,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockLoadSettings.mockReturnValue({
    handoff: { editorMode: "standalone" },
    index: { path: "/tmp/pi-sessions/index.sqlite" },
  });
  mockConnectPowerlineHandoffAutocomplete.mockResolvedValue(null);
});

describe("session handoff extension", () => {
  it("registers standalone prompt-editor integration on session_start by default", async () => {
    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.js");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const registerCommand = vi.fn();
    const pi = {
      events: { emit: vi.fn(), on: vi.fn() },
      registerCommand,
      on(event: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown>) {
        handlers.set(event, handler);
      },
    };

    sessionHandoffExtension(pi as never);

    expect(registerCommand).toHaveBeenCalledWith(
      "handoff",
      expect.objectContaining({ description: "Transfer context to a new focused session" }),
    );

    const sessionStartHandler = handlers.get("session_start");
    const beforeAgentStartHandler = handlers.get("before_agent_start");
    expect(sessionStartHandler).toBeDefined();
    expect(beforeAgentStartHandler).toBeDefined();

    const setEditorComponent = vi.fn();
    const setWidget = vi.fn();
    const onTerminalInput = vi.fn();
    const editorContext = {
      cwd: "/repo/app",
      hasUI: true,
      ui: { setEditorComponent, setWidget, onTerminalInput },
      sessionManager: { getSessionFile: () => "/tmp/current.jsonl", getEntries: () => [] },
    };
    await sessionStartHandler?.({ reason: "startup" }, editorContext);
    await sessionStartHandler?.(
      { reason: "new", previousSessionFile: "/tmp/previous.jsonl" },
      editorContext,
    );
    await sessionStartHandler?.(
      { reason: "fork", previousSessionFile: "/tmp/previous.jsonl" },
      editorContext,
    );
    expect(setEditorComponent).toHaveBeenCalledTimes(3);
    expect(setWidget).toHaveBeenCalledWith("pi-sessions.session-autocomplete", undefined);
    expect(mockConnectPowerlineHandoffAutocomplete).not.toHaveBeenCalled();

    await expect(beforeAgentStartHandler?.({})).resolves.toEqual({
      systemPrompt:
        "When the user references @session:<uuid>, treat it as a session token. If you call session_ask, pass only the UUID value, not the @session: prefix.",
    });
  });

  it("registers through the Powerline bridge when powerline mode is enabled", async () => {
    mockLoadSettings.mockReturnValue({
      handoff: { editorMode: "powerline" },
      index: { path: "/tmp/pi-sessions/index.sqlite" },
    });
    const disconnect = vi.fn();
    mockConnectPowerlineHandoffAutocomplete.mockResolvedValue({
      disconnect,
      interaction: {
        isActive: vi.fn().mockReturnValue(false),
        requestRefresh: vi.fn(),
        subscribe: vi.fn().mockReturnValue(() => {}),
        disconnect: vi.fn(),
      },
    });

    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.js");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = {
      events: { emit: vi.fn(), on: vi.fn() },
      registerCommand: vi.fn(),
      on(event: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown>) {
        handlers.set(event, handler);
      },
    };

    sessionHandoffExtension(pi as never);

    const sessionStartHandler = handlers.get("session_start");
    const setEditorComponent = vi.fn();
    const setWidget = vi.fn();
    const notify = vi.fn();
    const onTerminalInput = vi.fn().mockReturnValue(() => {});
    const editorContext = {
      cwd: "/repo/app",
      hasUI: true,
      ui: { setEditorComponent, setWidget, notify, onTerminalInput },
      sessionManager: { getSessionFile: () => "/tmp/current.jsonl", getEntries: () => [] },
    };

    await sessionStartHandler?.({}, editorContext);

    expect(mockConnectPowerlineHandoffAutocomplete).toHaveBeenCalledTimes(1);
    expect(onTerminalInput).toHaveBeenCalledTimes(1);
    expect(setEditorComponent).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("ignores alt+a repeat and release events in powerline mode", async () => {
    mockLoadSettings.mockReturnValue({
      handoff: { editorMode: "powerline" },
      index: { path: "/tmp/pi-sessions/index.sqlite" },
    });
    const requestRefresh = vi.fn();
    let terminalListener: ((data: string) => unknown) | undefined;
    mockConnectPowerlineHandoffAutocomplete.mockResolvedValue({
      disconnect: vi.fn(),
      interaction: {
        isActive: vi.fn().mockReturnValue(true),
        requestRefresh,
        subscribe: vi.fn().mockReturnValue(() => {}),
        disconnect: vi.fn(),
      },
    });

    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.js");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = {
      events: { emit: vi.fn(), on: vi.fn() },
      registerCommand: vi.fn(),
      on(event: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown>) {
        handlers.set(event, handler);
      },
    };

    sessionHandoffExtension(pi as never);

    const sessionStartHandler = handlers.get("session_start");
    const editorContext = {
      cwd: "/repo/app",
      hasUI: true,
      ui: {
        setEditorComponent: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
        onTerminalInput: vi.fn().mockImplementation((listener) => {
          terminalListener = listener;
          return () => {};
        }),
      },
      sessionManager: { getSessionFile: () => "/tmp/current.jsonl", getEntries: () => [] },
    };

    await sessionStartHandler?.({}, editorContext);

    expect(terminalListener).toBeDefined();
    expect(terminalListener?.("\x1b[97;3u")).toEqual({ consume: true });
    expect(requestRefresh).toHaveBeenNthCalledWith(1, { includeAllSessions: true });

    expect(terminalListener?.("\x1b[97;3:2u")).toBeUndefined();
    expect(terminalListener?.("\x1b[97;3:3u")).toBeUndefined();
    expect(requestRefresh).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when powerline mode is enabled but the bridge is unavailable", async () => {
    mockLoadSettings.mockReturnValue({
      handoff: { editorMode: "powerline" },
      index: { path: "/tmp/pi-sessions/index.sqlite" },
    });
    mockConnectPowerlineHandoffAutocomplete.mockResolvedValue(null);

    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.js");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const pi = {
      events: { emit: vi.fn(), on: vi.fn() },
      registerCommand: vi.fn(),
      on(event: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown>) {
        handlers.set(event, handler);
      },
    };

    sessionHandoffExtension(pi as never);

    const sessionStartHandler = handlers.get("session_start");
    const setEditorComponent = vi.fn();
    const setWidget = vi.fn();
    const notify = vi.fn();
    const onTerminalInput = vi.fn();
    const editorContext = {
      cwd: "/repo/app",
      hasUI: true,
      ui: { setEditorComponent, setWidget, notify, onTerminalInput },
      sessionManager: { getSessionFile: () => "/tmp/current.jsonl", getEntries: () => [] },
    };

    await sessionStartHandler?.({}, editorContext);
    await Promise.resolve();

    expect(mockConnectPowerlineHandoffAutocomplete).toHaveBeenCalledTimes(1);
    expect(setEditorComponent).not.toHaveBeenCalled();
    expect(onTerminalInput).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      'sessions.handoff.editor is set to "powerline", but the Powerline autocomplete bridge is unavailable.',
      "error",
    );
  });
});
