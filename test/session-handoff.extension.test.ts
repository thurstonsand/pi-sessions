import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadSettings = vi.fn();
const mockOpenSessionReferencePicker = vi.fn();

vi.mock("../extensions/shared/settings.js", () => ({
  loadSettings: mockLoadSettings,
}));

vi.mock("../extensions/session-handoff/picker.js", () => ({
  openSessionReferencePicker: mockOpenSessionReferencePicker,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockLoadSettings.mockReturnValue({
    handoff: { pickerShortcut: "alt+o" },
    index: { path: "/tmp/pi-sessions/index.sqlite" },
    autoTitle: { refreshTurns: 4, model: undefined },
  });
  mockOpenSessionReferencePicker.mockResolvedValue({ kind: "cancel" });
});

describe("session handoff extension", () => {
  it("registers the picker shortcut and keeps the session token system prompt note", async () => {
    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.js");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
    const registerCommand = vi.fn();
    const pi = {
      appendEntry: vi.fn(),
      sendUserMessage: vi.fn(),
      registerCommand,
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

    sessionHandoffExtension(pi as never);

    expect(registerCommand).toHaveBeenCalledWith(
      "handoff",
      expect.objectContaining({ description: "Transfer context to a new focused session" }),
    );
    expect(shortcuts.has("alt+o")).toBe(true);

    const beforeAgentStartHandler = handlers.get("before_agent_start");
    await expect(beforeAgentStartHandler?.({})).resolves.toEqual({
      systemPrompt:
        "When the user references @session:<uuid>, treat it as a session token. If you call session_ask, pass only the UUID value, not the @session: prefix.",
    });
  });

  it("opens the picker from alt+o and pastes the canonical token", async () => {
    mockOpenSessionReferencePicker.mockResolvedValue({
      kind: "insert-session-token",
      sessionId: "88171ce4-9021-4464-8cab-f49d04a82815",
    });

    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.js");
    const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
    const pi = {
      appendEntry: vi.fn(),
      sendUserMessage: vi.fn(),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(
        (shortcut: string, definition: { handler: (ctx: unknown) => Promise<void> }) => {
          shortcuts.set(shortcut, definition);
        },
      ),
      events: { emit: vi.fn(), on: vi.fn() },
      on: vi.fn(),
    };

    sessionHandoffExtension(pi as never);

    const pasteToEditor = vi.fn();
    await shortcuts.get("alt+o")?.handler({
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
      autoTitle: { refreshTurns: 4, model: undefined },
    });

    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.js");
    const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
    const pi = {
      appendEntry: vi.fn(),
      sendUserMessage: vi.fn(),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(
        (shortcut: string, definition: { handler: (ctx: unknown) => Promise<void> }) => {
          shortcuts.set(shortcut, definition);
        },
      ),
      events: { emit: vi.fn(), on: vi.fn() },
      on: vi.fn(),
    };

    sessionHandoffExtension(pi as never);

    expect(shortcuts.has("alt+p")).toBe(true);
    expect(shortcuts.has("alt+o")).toBe(false);
  });

  it("does nothing when the picker is cancelled", async () => {
    mockOpenSessionReferencePicker.mockResolvedValue({ kind: "cancel" });

    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.js");
    const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
    const pi = {
      appendEntry: vi.fn(),
      sendUserMessage: vi.fn(),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(
        (shortcut: string, definition: { handler: (ctx: unknown) => Promise<void> }) => {
          shortcuts.set(shortcut, definition);
        },
      ),
      events: { emit: vi.fn(), on: vi.fn() },
      on: vi.fn(),
    };

    sessionHandoffExtension(pi as never);

    const pasteToEditor = vi.fn();
    await shortcuts.get("alt+o")?.handler({
      hasUI: true,
      cwd: "/repo/app",
      ui: { pasteToEditor },
      sessionManager: { getSessionFile: () => "/tmp/current.jsonl" },
    });

    expect(pasteToEditor).not.toHaveBeenCalled();
  });
});
