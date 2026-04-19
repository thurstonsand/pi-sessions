import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHandoffBootstrap,
  createHandoffSessionMetadata,
  encodeHandoffBootstrap,
  HANDOFF_BOOTSTRAP_ENV,
  HANDOFF_STALE_SESSION_MESSAGE,
} from "../extensions/session-handoff/metadata.js";

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
  delete process.env[HANDOFF_BOOTSTRAP_ENV];

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

    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.js");
    const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
    const pi = createPiApi(new Map(), shortcuts, vi.fn());

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
    const pi = createPiApi(new Map(), shortcuts, vi.fn());

    sessionHandoffExtension(pi as never);

    expect(shortcuts.has("alt+p")).toBe(true);
    expect(shortcuts.has("alt+o")).toBe(false);
  });

  it("does nothing when the picker is cancelled", async () => {
    mockOpenSessionReferencePicker.mockResolvedValue({ kind: "cancel" });

    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.js");
    const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
    const pi = createPiApi(new Map(), shortcuts, vi.fn());

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

  it("materializes handoff metadata and sends the initial prompt on matching child session start", async () => {
    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.js");
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
        initial_prompt: "Approved handoff draft",
      }),
    );
    expect(pi.sendUserMessage).toHaveBeenCalledWith("Approved handoff draft");
    expect(process.env[HANDOFF_BOOTSTRAP_ENV]).toBeUndefined();
  });

  it("refuses bootstrap when the target session already has user input", async () => {
    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.js");
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
    const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.js");
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
}

function createSessionStartContext(options: { sessionId: string; entries?: unknown[] }) {
  return {
    hasUI: true,
    ui: {
      notify: vi.fn(),
    },
    sessionManager: {
      getSessionId() {
        return options.sessionId;
      },
      getEntries() {
        return options.entries ?? [];
      },
      appendCustomEntry: vi.fn(),
    },
  };
}
