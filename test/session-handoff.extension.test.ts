import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReadSessionHandoffSettings = vi.fn();
const mockConnectPowerlineHandoffAutocomplete = vi.fn();

vi.mock("../extensions/session-handoff/settings.js", () => ({
  readSessionHandoffSettings: mockReadSessionHandoffSettings,
}));

vi.mock("../extensions/session-handoff/powerline.js", () => ({
  connectPowerlineHandoffAutocomplete: mockConnectPowerlineHandoffAutocomplete,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockReadSessionHandoffSettings.mockReturnValue({
    editorHost: "auto",
    powerlineConfigured: false,
  });
  mockConnectPowerlineHandoffAutocomplete.mockResolvedValue(null);
});

describe("session handoff extension", () => {
  it("registers standalone prompt-editor integration on session lifecycle events by default", async () => {
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
    const sessionSwitchHandler = handlers.get("session_switch");
    const sessionForkHandler = handlers.get("session_fork");
    const beforeAgentStartHandler = handlers.get("before_agent_start");
    expect(sessionStartHandler).toBeDefined();
    expect(sessionSwitchHandler).toBeDefined();
    expect(sessionForkHandler).toBeDefined();
    expect(beforeAgentStartHandler).toBeDefined();

    const setEditorComponent = vi.fn();
    const setWidget = vi.fn();
    const onTerminalInput = vi.fn();
    const editorContext = {
      cwd: "/repo/app",
      hasUI: true,
      ui: { setEditorComponent, setWidget, onTerminalInput },
      sessionManager: { getSessionFile: () => "/tmp/current.jsonl" },
    };
    await sessionStartHandler?.({}, editorContext);
    await sessionSwitchHandler?.({}, editorContext);
    await sessionForkHandler?.({}, editorContext);
    expect(setEditorComponent).toHaveBeenCalledTimes(3);
    expect(setWidget).toHaveBeenCalledWith("pi-sessions.session-autocomplete", undefined);
    expect(mockConnectPowerlineHandoffAutocomplete).not.toHaveBeenCalled();

    await expect(beforeAgentStartHandler?.({})).resolves.toEqual({
      systemPrompt:
        "When the user references @session:<uuid>, treat it as a session token. If you call session_ask, pass only the UUID value, not the @session: prefix.",
    });
  });

  it("registers through the Powerline bridge when auto mode detects Powerline", async () => {
    mockReadSessionHandoffSettings.mockReturnValue({
      editorHost: "auto",
      powerlineConfigured: true,
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
      sessionManager: { getSessionFile: () => "/tmp/current.jsonl" },
    };

    await sessionStartHandler?.({}, editorContext);

    expect(mockConnectPowerlineHandoffAutocomplete).toHaveBeenCalledTimes(1);
    expect(onTerminalInput).toHaveBeenCalledTimes(1);
    expect(setEditorComponent).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
