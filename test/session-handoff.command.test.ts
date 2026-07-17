import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeModelRegistry } from "./test-helpers.ts";

const mockLoadSettings = vi.fn();
const mockGenerateHandoffDraft = vi.fn();
const mockReviewHandoffDraft = vi.fn();
const mockValidateSplitHandoffPrerequisites = vi.fn();
const mockPrepareHandoffLaunch = vi.fn();
const mockCreateGhosttyLaunchBackend = vi.fn();
const mockLaunch = vi.fn();
const mockCreateDeferredLaunchBackend = vi.fn();
const mockDeferredLaunch = vi.fn();
const mockGetFocusedGhosttyTerminalId = vi.fn();

vi.mock("../extensions/shared/settings.ts", () => ({
  loadSettings: mockLoadSettings,
}));

vi.mock("../extensions/session-handoff/extract.ts", () => ({
  generateHandoffDraftFromSessionManager: mockGenerateHandoffDraft,
  resolveHandoffSource: vi.fn(() => ({ messages: [{}] })),
}));

vi.mock("../extensions/session-handoff/review.ts", async () => {
  const actual = await vi.importActual<object>("../extensions/session-handoff/review.ts");
  return {
    ...actual,
    reviewHandoffDraft: mockReviewHandoffDraft,
  };
});

vi.mock("../extensions/session-handoff/spawn.ts", () => ({
  prepareHandoffLaunch: mockPrepareHandoffLaunch,
}));

vi.mock("../extensions/session-handoff/launch/ghostty.ts", () => ({
  validateSplitHandoffPrerequisites: mockValidateSplitHandoffPrerequisites,
  isGhosttyHandoffAvailable: vi.fn(() => false),
  getFocusedGhosttyTerminalId: mockGetFocusedGhosttyTerminalId,
  createGhosttyLaunchBackend: mockCreateGhosttyLaunchBackend,
}));

vi.mock("../extensions/session-handoff/launch/deferred.ts", () => ({
  createDeferredLaunchBackend: mockCreateDeferredLaunchBackend,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  mockLoadSettings.mockReturnValue({
    handoff: { pickerShortcut: "alt+o", deferred: { copyToClipboard: true } },
    index: { path: "/tmp/pi-sessions/index.sqlite" },
    autoTitle: { refreshTurns: 4, model: undefined, prompt: "Default auto-title prompt" },
  });
  mockGenerateHandoffDraft.mockResolvedValue({
    draft: "Generated handoff draft",
    context: {
      title: "Finish phase 1",
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
  mockPrepareHandoffLaunch.mockImplementation((options: { model?: string }) => ({
    sessionId: "child-session-123",
    resumeCommand: `RESUME child-session-123 ${options.model ?? "inherit"}`,
  }));
  mockLaunch.mockResolvedValue({ success: true });
  mockCreateGhosttyLaunchBackend.mockReturnValue({ launch: mockLaunch });
  mockDeferredLaunch.mockImplementation(async () => ({
    success: true,
    clipboardStatus: "copied",
  }));
  mockCreateDeferredLaunchBackend.mockReturnValue({ launch: mockDeferredLaunch });
  mockGetFocusedGhosttyTerminalId.mockResolvedValue("terminal-123");
});

describe("session handoff command", () => {
  it("requires a goal", async () => {
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("   ", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Usage: /handoff [--left|--right|--up|--down|--deferred] <goal for new thread>",
      "error",
    );
  });

  it("rejects multiple split flags", async () => {
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("--left --right Finish phase 1", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Use only one launch target: --left, --right, --up, --down, or --deferred.",
      "error",
    );
  });

  it("rejects mixing --deferred with a split flag", async () => {
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("--deferred --left Finish phase 1", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Use only one launch target: --left, --right, --up, --down, or --deferred.",
      "error",
    );
  });

  it("runs a deferred handoff and copies the resume command", async () => {
    const { handler, pi } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("--deferred Finish phase 1", ctx as never);

    expect(mockValidateSplitHandoffPrerequisites).not.toHaveBeenCalled();
    expect(mockCreateDeferredLaunchBackend).toHaveBeenCalledWith({ copyToClipboard: true });
    expect(mockDeferredLaunch).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      title: "Finish phase 1",
      resumeCommand: expect.stringContaining("openai/gpt-5.4"),
    });
    expect(mockCreateGhosttyLaunchBackend).not.toHaveBeenCalled();
    expect(ctx.newSession).not.toHaveBeenCalled();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "pi-sessions.handoff-launch-receipt",
      expect.objectContaining({
        sessionId: "child-session-123",
        title: "Finish phase 1",
        launch: "deferred",
        resumeCommand: expect.stringContaining("child-session-123"),
      }),
    );
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("includes the resume command when clipboard copy is disabled", async () => {
    mockLoadSettings.mockReturnValue({
      handoff: { pickerShortcut: "alt+o", deferred: { copyToClipboard: false } },
      index: { path: "/tmp/pi-sessions/index.sqlite" },
      autoTitle: { refreshTurns: 4, model: undefined, prompt: "Default auto-title prompt" },
    });
    mockDeferredLaunch.mockResolvedValue({ success: true });
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("--deferred Finish phase 1", ctx as never);

    expect(mockCreateDeferredLaunchBackend).toHaveBeenCalledWith({ copyToClipboard: false });
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("identifies the focused Ghostty terminal and ignores other arguments", async () => {
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("--identify --right Finish phase 1", ctx as never);

    expect(mockGetFocusedGhosttyTerminalId).toHaveBeenCalledWith(expect.anything(), "/tmp/project");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Identified Ghostty terminal terminal-123.", "info");
    expect(mockGenerateHandoffDraft).not.toHaveBeenCalled();
  });

  it("requires conversation context", async () => {
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext({ hasMessages: false });

    await handler("Finish phase 1", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith("No conversation to hand off", "error");
  });

  it("creates a prepared child session and switches into it for plain handoff", async () => {
    vi.useFakeTimers();
    try {
      const { handler } = await getHandoffCommand();
      const ctx = createCommandContext();

      await handler("Finish phase 1", ctx as never);

      expect(mockPrepareHandoffLaunch).not.toHaveBeenCalled();
      expect(ctx.newSession).toHaveBeenCalledWith({
        parentSession: "/tmp/session.jsonl",
        setup: expect.any(Function),
        withSession: expect.any(Function),
      });
      expect(ctx.sessionSetup.appendSessionInfo).toHaveBeenCalledWith("Finish phase 1");
      expect(ctx.sessionSetup.appendCustomEntry).toHaveBeenCalledWith(
        "pi-sessions.handoff",
        expect.objectContaining({ title: "Finish phase 1" }),
      );
      expect(ctx.ui.notify).not.toHaveBeenCalledWith("Handoff started in a new session.", "info");
      expect(ctx.replacementContext.sendMessage).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();

      expect(ctx.replacementContext.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "pi-sessions.handoff-kickoff",
          content: "Approved handoff draft",
          details: expect.objectContaining({
            title: "Finish phase 1",
            source: { sessionId: "parent-session-1", sessionName: "Parent Session" },
          }),
        }),
        { triggerTurn: true },
      );
      expect(ctx.replacementContext.ui.notify).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("launches a split-pane handoff when a split flag is provided", async () => {
    const { handler, pi } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("--right Finish phase 1", ctx as never);

    expect(mockValidateSplitHandoffPrerequisites).toHaveBeenCalledWith(ctx);
    expect(mockPrepareHandoffLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        targetCwd: "/tmp/project",
        parentCwd: "/tmp/project",
        parentSessionDir: "/tmp/sessions",
        parentSessionFile: "/tmp/session.jsonl",
        title: "Finish phase 1",
        model: "openai/gpt-5.4",
        buildBootstrap: expect.any(Function),
      }),
    );
    expect(mockCreateGhosttyLaunchBackend).toHaveBeenCalledWith(pi, {
      direction: "right",
      terminalId: undefined,
      fallbackToFocusedOnError: true,
    });
    expect(mockLaunch).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      title: "Finish phase 1",
      resumeCommand: "RESUME child-session-123 openai/gpt-5.4",
    });
    expect(ctx.newSession).not.toHaveBeenCalled();
    expect(ctx.switchSession).not.toHaveBeenCalled();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "pi-sessions.handoff-launch-receipt",
      expect.objectContaining({ launch: "right", backend: "Ghostty" }),
    );
    expect(ctx.ui.notify).not.toHaveBeenCalled();

    const options = mockPrepareHandoffLaunch.mock.calls[0]?.[0] as {
      buildBootstrap: (sessionId: string) => unknown;
    };
    expect(options.buildBootstrap("child-session-123")).toEqual({
      sessionId: "child-session-123",
      goal: "Finish phase 1",
      nextTask: "Task",
      title: "Finish phase 1",
      initialPrompt: "Approved handoff draft",
      source: { sessionId: "parent-session-1", sessionName: "Parent Session" },
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
    mockLaunch.mockResolvedValue({
      success: false,
      error:
        "Failed to launch Ghostty split: boom. Split handoff currently supports Ghostty on macOS only.",
    });
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("--right Finish phase 1", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to launch Ghostty split: boom. Split handoff currently supports Ghostty on macOS only. Created handoff session child-session-123; start it manually with: RESUME child-session-123",
      ),
      "error",
    );
  });

  it("errors on a --model with no value", async () => {
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("--model", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Usage: /handoff [--left|--right|--up|--down|--deferred] <goal for new thread>",
      "error",
    );
    expect(mockGenerateHandoffDraft).not.toHaveBeenCalled();
  });

  it("errors on an unknown --model before generating a draft", async () => {
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("--model ghost/model Finish phase 1", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Model "ghost/model" not found.'),
      "error",
    );
    expect(mockGenerateHandoffDraft).not.toHaveBeenCalled();
  });

  it("passes an overridden model to a deferred resume command", async () => {
    const { handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("--deferred --model openai/gpt-5.4-mini Finish phase 1", ctx as never);

    expect(mockDeferredLaunch).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      title: "Finish phase 1",
      resumeCommand: expect.stringContaining("openai/gpt-5.4-mini"),
    });
  });

  it("applies a --model override to the in-place session after switch", async () => {
    const { pi, handler } = await getHandoffCommand();
    const ctx = createCommandContext();

    await handler("--model openai/gpt-5.4-mini:high Finish phase 1", ctx as never);

    expect(ctx.newSession).toHaveBeenCalled();
    expect(pi.setModel).toHaveBeenCalledWith({ provider: "openai", id: "gpt-5.4-mini" });
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
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
  });
});

async function getHandoffCommand(): Promise<{
  pi: ExtensionAPI;
  handler: (args: string, ctx: unknown) => Promise<void>;
}> {
  const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.ts");
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
    registerEntryRenderer: vi.fn(),
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
    setModel: vi.fn().mockResolvedValue(true),
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
  const sessionSetup = {
    appendSessionInfo: vi.fn(),
    appendCustomEntry: vi.fn(),
  };

  const replacementContext = {
    mode: "tui",
    hasUI: true,
    sendUserMessage: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    ui: {
      notify: vi.fn(),
    },
  };

  return {
    cwd: "/tmp/project",
    mode: "tui",
    hasUI: true,
    model: { provider: "openai", id: "gpt-5.4" },
    modelRegistry: createFakeModelRegistry({
      available: [
        { provider: "openai", id: "gpt-5.4" },
        { provider: "openai", id: "gpt-5.4-mini" },
      ],
    }),
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
      getSessionId() {
        return "parent-session-1";
      },
      getSessionName() {
        return "Parent Session";
      },
    },
    replacementContext,
    sessionSetup,
    newSession: vi.fn(
      async (options?: {
        setup?: (sessionManager: typeof sessionSetup) => Promise<void>;
        withSession?: (ctx: typeof replacementContext) => Promise<void>;
      }) => {
        if (!switchCancelled) {
          await options?.setup?.(sessionSetup);
          await options?.withSession?.(replacementContext);
        }

        return { cancelled: switchCancelled };
      },
    ),
    switchSession: vi.fn(),
  };
}
