import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadSettings = vi.fn();
const mockGenerateHandoffDraft = vi.fn();
const mockReviewHandoffDraft = vi.fn();

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

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockLoadSettings.mockReturnValue({
    handoff: { editorMode: "standalone" },
    index: { path: "/tmp/pi-sessions/index.sqlite" },
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
});

describe("session handoff command", () => {
  it("requires a goal", async () => {
    const handler = await getHandoffHandler();
    const ctx = createCommandContext();

    await handler("   ", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /handoff <goal for new thread>", "error");
  });

  it("requires conversation context", async () => {
    const handler = await getHandoffHandler();
    const ctx = createCommandContext({ hasMessages: false });

    await handler("Finish phase 1", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith("No conversation to hand off", "error");
  });

  it("creates a new session and queues the approved draft for delivery in the child session", async () => {
    const handler = await getHandoffHandler();
    const ctx = createCommandContext();

    await handler("Finish phase 1", ctx as never);

    expect(ctx.newSession).toHaveBeenCalledWith(
      expect.objectContaining({ parentSession: "/tmp/session.jsonl", setup: expect.any(Function) }),
    );
    expect(ctx.appendCustomEntry).toHaveBeenCalledWith(
      "pi-sessions.handoff",
      expect.objectContaining({
        origin: "handoff",
        goal: "Finish phase 1",
        nextTask: "Task",
        initial_prompt: "Approved handoff draft",
        initial_prompt_nonce: expect.any(String),
      }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith("Handoff started in a new session.", "info");
  });

  it("stops when review is cancelled", async () => {
    mockReviewHandoffDraft.mockResolvedValue(undefined);
    const handler = await getHandoffHandler();
    const ctx = createCommandContext();

    await handler("Finish phase 1", ctx as never);

    expect(ctx.newSession).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled", "info");
  });

  it("stops when the new session is cancelled", async () => {
    const handler = await getHandoffHandler();
    const ctx = createCommandContext({ newSessionCancelled: true });

    await handler("Finish phase 1", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith("New session cancelled", "info");
  });
});

async function getHandoffHandler(): Promise<(args: string, ctx: unknown) => Promise<void>> {
  const { default: sessionHandoffExtension } = await import("../extensions/session-handoff.js");
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = createPiApi(commands);
  sessionHandoffExtension(pi as never);
  const command = commands.get("handoff");
  if (!command) {
    throw new Error("handoff command was not registered");
  }
  return command.handler;
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

function createCommandContext(options?: { hasMessages?: boolean; newSessionCancelled?: boolean }) {
  const hasMessages = options?.hasMessages ?? true;
  const newSessionCancelled = options?.newSessionCancelled ?? false;
  const appendCustomEntry = vi.fn();

  return {
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
      getSessionFile() {
        return "/tmp/session.jsonl";
      },
    },
    appendCustomEntry,
    newSession: vi.fn(
      async (sessionOptions?: {
        setup?: (sessionManager: { appendCustomEntry: typeof appendCustomEntry }) => Promise<void>;
      }) => {
        if (!newSessionCancelled) {
          await sessionOptions?.setup?.({ appendCustomEntry } as never);
        }
        return { cancelled: newSessionCancelled };
      },
    ),
  };
}
