import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSessionHandoffCommandHandler } from "../extensions/session-handoff.js";

describe("session handoff command", () => {
  it("requires a goal", async () => {
    const ctx = createCommandContext();
    const handler = createSessionHandoffCommandHandler(createPiApi(), createDependencies());

    await handler("   ", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /handoff <goal for new thread>", "error");
  });

  it("requires conversation context", async () => {
    const ctx = createCommandContext({ hasMessages: false });
    const handler = createSessionHandoffCommandHandler(createPiApi(), createDependencies());

    await handler("Finish phase 1", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith("No conversation to hand off", "error");
  });

  it("creates a new session, persists handoff metadata, and sends the approved draft", async () => {
    const pi = createPiApi();
    const ctx = createCommandContext();
    const handler = createSessionHandoffCommandHandler(
      pi,
      createDependencies({ approvedDraft: "Approved handoff draft" }),
    );

    await handler("Finish phase 1", ctx as never);

    expect(ctx.newSession).toHaveBeenCalledWith(
      expect.objectContaining({ parentSession: "/tmp/session.jsonl", setup: expect.any(Function) }),
    );
    expect(ctx.appendCustomEntry).toHaveBeenCalledWith("pi-sessions.handoff", {
      origin: "handoff",
      goal: "Finish phase 1",
      nextTask: "Task",
    });
    expect(pi.sendUserMessage).toHaveBeenCalledWith("Approved handoff draft");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Handoff started in a new session.", "info");
  });

  it("stops when review is cancelled", async () => {
    const pi = createPiApi();
    const ctx = createCommandContext();
    const handler = createSessionHandoffCommandHandler(
      pi,
      createDependencies({ approvedDraft: undefined }),
    );

    await handler("Finish phase 1", ctx as never);

    expect(ctx.newSession).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled", "info");
  });

  it("stops when the new session is cancelled", async () => {
    const pi = createPiApi();
    const ctx = createCommandContext({ newSessionCancelled: true });
    const handler = createSessionHandoffCommandHandler(
      pi,
      createDependencies({ approvedDraft: "Approved handoff draft" }),
    );

    await handler("Finish phase 1", ctx as never);

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("New session cancelled", "info");
  });
});

function createPiApi(): ExtensionAPI {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
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

function createDependencies(options?: { approvedDraft?: string | undefined }) {
  return {
    async generateDraft() {
      return {
        draft: "Generated handoff draft",
        context: {
          summary: "Summary",
          relevantFiles: [],
          nextTask: "Task",
          openQuestions: [],
        },
        sessionId: "session-123",
        sessionPath: "/tmp/session.jsonl",
      };
    },
    async reviewDraft(_ctx: unknown, draft: string) {
      expect(draft).toBe("Generated handoff draft");
      return options?.approvedDraft;
    },
    async runWithLoader<T>(
      _ctx: unknown,
      _label: string,
      task: (signal: AbortSignal) => Promise<T>,
    ) {
      return task(new AbortController().signal);
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
      custom: vi.fn(),
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
          await sessionOptions?.setup?.({ appendCustomEntry });
        }
        return { cancelled: newSessionCancelled };
      },
    ),
  };
}
