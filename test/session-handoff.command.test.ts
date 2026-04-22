import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HANDOFF_BOOTSTRAP_ENV,
  parseHandoffBootstrap,
} from "../extensions/session-handoff/metadata.js";

const mockLoadSettings = vi.fn();
const mockGenerateHandoffDraft = vi.fn();
const mockReviewHandoffDraft = vi.fn();
const mockValidateSplitHandoffPrerequisites = vi.fn();
const mockCreateHandoffSession = vi.fn();
const mockLaunchSplitHandoffSession = vi.fn();

vi.mock("../extensions/shared/settings.js", () => ({
  loadSettings: mockLoadSettings,
}));

vi.mock("../extensions/session-handoff/extract.js", () => ({
  generateHandoffDraft: mockGenerateHandoffDraft,
}));

vi.mock("../extensions/session-handoff/review.js", async () => {
  const actual = await vi.importActual<object>("../extensions/session-handoff/review.js");
  return {
    ...actual,
    reviewHandoffDraft: mockReviewHandoffDraft,
  };
});

vi.mock("../extensions/session-handoff/spawn.js", () => ({
  buildPiResumeCommand: vi.fn(
    (sessionDir: string, sessionId: string, bootstrapValue: string) =>
      `PI_SESSIONS_HANDOFF_BOOTSTRAP='${bootstrapValue}' pi --session-dir ${sessionDir} --session ${sessionId}`,
  ),
  validateSplitHandoffPrerequisites: mockValidateSplitHandoffPrerequisites,
  createHandoffSession: mockCreateHandoffSession,
  launchSplitHandoffSession: mockLaunchSplitHandoffSession,
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
  mockGenerateHandoffDraft.mockResolvedValue({
    draft: "Generated handoff draft",
    context: {
      summary: "Summary",
      relevantFiles: [],
      nextTask: "Task",
      openQuestions: [],
    },
    sessionId: "session-123",
    sessionPath: "/tmp/session.jsonl",
  });
  mockReviewHandoffDraft.mockResolvedValue("Approved handoff draft");
  mockValidateSplitHandoffPrerequisites.mockResolvedValue(undefined);
  mockCreateHandoffSession.mockReturnValue({
    sessionId: "child-session-123",
    sessionFile: "/tmp/sessions/child-session-123.jsonl",
  });
  mockLaunchSplitHandoffSession.mockResolvedValue({ success: true });
});

describe("session handoff command", () => {
  it("requires a goal", async () => {
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("   ", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Usage: /handoff [--left|--right|--up|--down] <goal for new thread>",
      "error",
    );
  });

  it("rejects multiple split flags", async () => {
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("--left --right Finish phase 1", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Use only one split flag: --left, --right, --up, or --down.",
      "error",
    );
  });

  it("requires conversation context", async () => {
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext({ hasMessages: false });

    await handler("Finish phase 1", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith("No conversation to hand off", "error");
  });

  it("creates a prepared child session and switches into it for plain handoff", async () => {
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("Finish phase 1", ctx as never);

    expect(mockCreateHandoffSession).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      sessionDir: "/tmp/sessions",
      parentSessionFile: "/tmp/session.jsonl",
    });
    expect(ctx.switchSession).toHaveBeenCalledWith("/tmp/sessions/child-session-123.jsonl");
    expect(ctx.ui.notify).not.toHaveBeenCalledWith("Handoff started in a new session.", "info");
    expect(process.env[HANDOFF_BOOTSTRAP_ENV]).toBeUndefined();
  });

  it("launches a split-pane handoff when a split flag is provided", async () => {
    const { handler, pi } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("--right Finish phase 1", ctx as never);

    expect(mockValidateSplitHandoffPrerequisites).toHaveBeenCalledWith(pi, ctx);
    expect(mockCreateHandoffSession).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      sessionDir: "/tmp/sessions",
      parentSessionFile: "/tmp/session.jsonl",
    });
    expect(mockLaunchSplitHandoffSession).toHaveBeenCalledWith(pi, {
      cwd: "/tmp/project",
      sessionDir: "/tmp/sessions",
      direction: "right",
      sessionId: "child-session-123",
      bootstrapValue: expect.any(String),
    });
    expect(ctx.switchSession).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Handoff started in a new pane (right).", "info");

    const launchOptions = mockLaunchSplitHandoffSession.mock.calls[0]?.[1] as {
      bootstrapValue: string;
    };
    expect(parseHandoffBootstrap(launchOptions.bootstrapValue)).toEqual({
      sessionId: "child-session-123",
      goal: "Finish phase 1",
      nextTask: "Task",
      initialPrompt: "Approved handoff draft",
    });
  });

  it("fails loudly when split-pane preflight fails", async () => {
    mockValidateSplitHandoffPrerequisites.mockResolvedValue(
      "Split handoff requires running inside Ghostty.",
    );
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("--right Finish phase 1", ctx as never);

    expect(mockGenerateHandoffDraft).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Split handoff requires running inside Ghostty.",
      "error",
    );
  });

  it("reports the created session id when split-pane launch fails", async () => {
    mockLaunchSplitHandoffSession.mockResolvedValue({
      success: false,
      error:
        "Failed to launch Ghostty split: boom. Split handoff currently supports Ghostty on macOS only.",
    });
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("--right Finish phase 1", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to launch Ghostty split: boom. Split handoff currently supports Ghostty on macOS only. Created handoff session child-session-123; start it manually with: PI_SESSIONS_HANDOFF_BOOTSTRAP=",
      ),
      "error",
    );
  });

  it("stops when review is cancelled", async () => {
    mockReviewHandoffDraft.mockResolvedValue(undefined);
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("Finish phase 1", ctx as never);

    expect(ctx.switchSession).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled", "info");
  });

  it("stops when the session switch is cancelled", async () => {
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext({ switchCancelled: true });

    await handler("Finish phase 1", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Session switch cancelled", "info");
    expect(process.env[HANDOFF_BOOTSTRAP_ENV]).toBeUndefined();
  });
});

async function getHandoffCommand(): Promise<{
  pi: ExtensionAPI;
  handler: (args: string, ctx: unknown) => Promise<void>;
}> {
  const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.js");
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = createPiApi(commands);
  sessionHandoffExtension(pi as never);
  const command = commands.get("handoff");
  if (!command) {
    throw new Error("handoff command was not registered");
  }
  return { pi: pi as never, handler: command.handler };
}

function createPiApi(
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>,
): ExtensionAPI {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(
      (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        commands.set(name, definition);
      },
    ),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    setLabel: vi.fn(),
    exec: vi.fn(),
    getActiveTools: vi.fn(),
    getAllTools: vi.fn(),
    setActiveTools: vi.fn(),
    getCommands: vi.fn(),
    setModel: vi.fn(),
    getThinkingLevel: vi.fn(),
    setThinkingLevel: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    events: {
      emit: vi.fn(),
      on: vi.fn().mockReturnValue(() => {}),
    },
  };
}

function createCommandContext(options?: { hasMessages?: boolean; switchCancelled?: boolean }) {
  const hasMessages = options?.hasMessages ?? true;
  const switchCancelled = options?.switchCancelled ?? false;

  return {
    cwd: "/tmp/project",
    hasUI: true,
    model: { provider: "openai", id: "gpt-5.4" },
    ui: {
      notify: vi.fn(),
      custom: vi.fn(async (factory: (...args: unknown[]) => unknown) => {
        return await new Promise((resolve) => {
          factory(
            { requestRender() {} },
            {
              fg(_color: string, text: string) {
                return text;
              },
              bold(text: string) {
                return text;
              },
              bg(_color: string, text: string) {
                return text;
              },
            },
            undefined,
            resolve,
          );
        });
      }),
      editor: vi.fn(),
    },
    sessionManager: {
      getEntries() {
        if (!hasMessages) {
          return [];
        }

        return [
          {
            type: "message",
            id: "user-1",
            parentId: null,
            timestamp: "2026-03-23T00:00:00.000Z",
            message: {
              role: "user",
              content: [{ type: "text", text: "Please implement phase 1." }],
              timestamp: 1,
            },
          },
        ];
      },
      getLeafId() {
        return hasMessages ? "user-1" : null;
      },
      getSessionDir() {
        return "/tmp/sessions";
      },
      getSessionFile() {
        return "/tmp/session.jsonl";
      },
    },
    switchSession: vi.fn(async () => ({ cancelled: switchCancelled })),
  };
}
