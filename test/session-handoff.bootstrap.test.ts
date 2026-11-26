import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumePendingHandoffBootstrap } from "../extensions/session-handoff/bootstrap.ts";
import {
  createChildGeneratedHandoffBootstrap,
  HANDOFF_BOOTSTRAP_FAILED_CUSTOM_TYPE,
  HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
  HANDOFF_METADATA_CUSTOM_TYPE,
  HANDOFF_STALE_SESSION_MESSAGE,
  isSessionStarting,
} from "../extensions/session-handoff/metadata.ts";
import { createFakeModelRuntime } from "./test-helpers.ts";

const { generateHandoffDraftMock } = vi.hoisted(() => ({
  generateHandoffDraftMock: vi.fn(),
}));

vi.mock("../extensions/session-handoff/extract.ts", () => ({
  generateHandoffDraftFromSessionManager: generateHandoffDraftMock,
}));

afterEach(() => {
  vi.restoreAllMocks();
  generateHandoffDraftMock.mockReset();
});

describe("session handoff bootstrap", () => {
  it("uses the configured extraction model and notifies the child of persisted runs", async () => {
    const sourceSessionManager = {
      getSessionId: () => "parent-session",
      getSessionName: () => "Parent",
    };
    vi.spyOn(SessionManager, "open").mockReturnValue(sourceSessionManager as never);
    generateHandoffDraftMock.mockResolvedValue({
      draft: "Generated handoff draft",
      context: { summary: "Relevant context.", relevantFiles: [], openQuestions: [] },
      sessionId: "parent-session",
      sessionPath: "/tmp/parent.jsonl",
      debugSessionPath: "/tmp/handoff-runs/extraction.jsonl",
    });

    const bootstrapEntry = {
      type: "custom",
      id: "bootstrap-1",
      parentId: null,
      timestamp: "2026-03-23T00:00:00.000Z",
      customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
      data: createChildGeneratedHandoffBootstrap({
        sessionId: "child-session",
        briefing: "Finish phase 1",
        title: "Finish phase 1",
        parentSessionFile: "/tmp/parent.jsonl",
        sourceLeafId: "source-leaf",
        reportBack: false,
        bootstrapMode: "automatic",
        launch: "subagent",
        subagent: {
          childSessionId: "child-session",
          ownerSessionId: "owner-session",
          depth: 1,
          reportBack: false,
        },
      }),
    };
    const notify = vi.fn();
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: "/tmp/project",
      modelRegistry: {},
      ui: {
        notify,
        custom: vi.fn(
          (
            factory: (
              tui: unknown,
              theme: unknown,
              keybindings: unknown,
              done: (value: unknown) => void,
            ) => unknown,
          ) =>
            new Promise((resolve) => {
              factory({}, {}, {}, resolve);
            }),
        ),
      },
      sessionManager: {
        getSessionId: () => "child-session",
        getBranch: () => [bootstrapEntry],
        getEntries: () => [bootstrapEntry],
      },
      shutdown: vi.fn(),
    };
    const pi = {
      appendEntry: vi.fn(),
      setSessionName: vi.fn(),
      sendMessage: vi.fn(),
    };
    const extractionModel = {
      provider: "openai-codex",
      id: "gpt-5.6-terra",
    };
    const modelRuntime = createFakeModelRuntime({ available: [extractionModel as never] });
    const getModelRuntime = vi.fn().mockReturnValue(modelRuntime);
    const handoffSettings = {
      pickerShortcut: "alt+o" as const,
      roster: [],
      model: "openai-codex/gpt-5.6-terra",
      thinkingLevel: "low" as const,
      persistRuns: true,
      deferred: { enable: true, copyToClipboard: true },
    };

    await consumePendingHandoffBootstrap(
      pi as never,
      ctx as never,
      getModelRuntime,
      "medium",
      handoffSettings,
    );

    expect(generateHandoffDraftMock).toHaveBeenCalledWith({
      ctx,
      modelRuntime,
      sourceSessionManager,
      sourceLeafId: "source-leaf",
      briefing: "Finish phase 1",
      settings: handoffSettings,
      destinationThinkingLevel: "medium",
      signal: expect.any(AbortSignal),
      reportBack: false,
    });
    expect(notify).toHaveBeenCalledWith(
      "Handoff extraction session saved to /tmp/handoff-runs/extraction.jsonl",
      "info",
    );
    expect(pi.sendMessage).toHaveBeenCalledOnce();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      HANDOFF_METADATA_CUSTOM_TYPE,
      expect.objectContaining({
        origin: "handoff",
        launch: "subagent",
      }),
    );
    const metadata = pi.appendEntry.mock.calls.find(
      ([customType]) => customType === HANDOFF_METADATA_CUSTOM_TYPE,
    )?.[1];
    expect(metadata).not.toHaveProperty("subagent");
  });

  it("records why an automatic bootstrap failed before shutting the child down", async () => {
    const { ctx, pi, entries } = createFailingChildHarness();

    await consumeBootstrap(pi, ctx);

    expect(pi.appendEntry).toHaveBeenCalledWith(HANDOFF_BOOTSTRAP_FAILED_CUSTOM_TYPE, {
      bootstrapEntryId: "bootstrap-1",
      error: "Handoff extraction failed: The usage limit has been reached",
    });
    expect(ctx.shutdown).toHaveBeenCalledOnce();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    // The bootstrap stays pending so a resume retries it, but the dead session
    // no longer reads as one that is still starting.
    expect(isSessionStarting(entries as never)).toBe(false);
  });

  it("latches an automatic bootstrap open once a failure is already recorded", async () => {
    const { ctx, pi } = createFailingChildHarness([
      {
        type: "custom",
        id: "failure-1",
        parentId: "bootstrap-1",
        timestamp: "2026-03-23T00:00:01.000Z",
        customType: HANDOFF_BOOTSTRAP_FAILED_CUSTOM_TYPE,
        data: { bootstrapEntryId: "bootstrap-1", error: "Handoff extraction failed: earlier" },
      },
    ]);

    await consumeBootstrap(pi, ctx);

    expect(ctx.shutdown).not.toHaveBeenCalled();
    expect(pi.appendEntry).toHaveBeenCalledWith(HANDOFF_BOOTSTRAP_FAILED_CUSTOM_TYPE, {
      bootstrapEntryId: "bootstrap-1",
      error: "Handoff extraction failed: The usage limit has been reached",
    });
  });
});

function createFailingChildHarness(seedEntries: unknown[] = []) {
  vi.spyOn(SessionManager, "open").mockReturnValue({
    getSessionId: () => "parent-session",
    getSessionName: () => "Parent",
  } as never);
  generateHandoffDraftMock.mockRejectedValue(
    new Error("Handoff extraction failed: The usage limit has been reached"),
  );

  const entries: unknown[] = [
    {
      type: "custom",
      id: "bootstrap-1",
      parentId: null,
      timestamp: "2026-03-23T00:00:00.000Z",
      customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
      data: createChildGeneratedHandoffBootstrap({
        sessionId: "child-session",
        briefing: "Finish phase 1",
        title: "Finish phase 1",
        parentSessionFile: "/tmp/parent.jsonl",
        sourceLeafId: "source-leaf",
        reportBack: false,
        bootstrapMode: "automatic",
        launch: "subagent",
        subagent: {
          childSessionId: "child-session",
          ownerSessionId: "owner-session",
          depth: 1,
          reportBack: false,
        },
      }),
    },
    ...seedEntries,
  ];

  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: "/tmp/project",
    modelRegistry: {},
    ui: {
      notify: vi.fn(),
      custom: vi.fn(
        (
          factory: (
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: (value: unknown) => void,
          ) => unknown,
        ) =>
          new Promise((resolve) => {
            factory({}, {}, {}, resolve);
          }),
      ),
    },
    sessionManager: {
      getSessionId: () => "child-session",
      getBranch: () => entries,
      getEntries: () => entries,
    },
    shutdown: vi.fn(),
  };
  const pi = {
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({
        type: "custom",
        id: `entry-${entries.length}`,
        parentId: null,
        timestamp: "2026-03-23T00:00:02.000Z",
        customType,
        data,
      });
    }),
    setSessionName: vi.fn(),
    sendMessage: vi.fn(),
  };

  return { ctx, pi, entries };
}

function consumeBootstrap(pi: unknown, ctx: unknown): Promise<void> {
  return consumePendingHandoffBootstrap(
    pi as never,
    ctx as never,
    vi.fn().mockResolvedValue(createFakeModelRuntime({ available: [] })),
    "medium",
    {
      pickerShortcut: "alt+o" as const,
      roster: [],
      persistRuns: false,
      deferred: { enable: true, copyToClipboard: true },
    },
  );
}

describe("session handoff bootstrap over RPC", () => {
  it("generates the draft without custom UI and starts the session once the user accepts", async () => {
    const { ctx, pi } = createRpcReviewHarness(async () => "Start session");

    await consumeBootstrap(pi, ctx);

    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenNthCalledWith(
      1,
      "pi-sessions-handoff",
      "Generating handoff draft...",
    );
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-sessions-handoff", undefined);
    const [title, options, opts] = ctx.ui.select.mock.calls[0] ?? [];
    expect(title).toContain("Generated handoff draft");
    expect(options).toEqual(["Start session", "Edit prompt", "Put prompt in editor"]);
    expect(opts).toEqual({ timeout: 8_000 });
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Generated handoff draft") }),
      { triggerTurn: true },
    );
  });

  it("sends the edited prompt when the user edits it first", async () => {
    const { ctx, pi } = createRpcReviewHarness(async () => "Edit prompt");
    ctx.ui.editor.mockResolvedValue("Edited draft");

    await consumeBootstrap(pi, ctx);

    expect(ctx.ui.editor).toHaveBeenCalledWith("Edit handoff prompt", "Generated handoff draft");
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Edited draft") }),
      { triggerTurn: true },
    );
  });

  it("puts the draft in the editor when the user dismisses the preview", async () => {
    const { ctx, pi } = createRpcReviewHarness(async () => undefined);

    await consumeBootstrap(pi, ctx);

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("Generated handoff draft");
  });

  it("drops the handoff when the user starts the conversation while the preview is open", async () => {
    const { ctx, pi, entries } = createRpcReviewHarness(async () => {
      entries.push({
        type: "message",
        id: "user-1",
        parentId: "bootstrap-1",
        timestamp: "2026-03-23T00:00:01.000Z",
        message: { role: "user", content: "Something else", timestamp: 1 },
      });
      return "Start session";
    });

    await consumeBootstrap(pi, ctx);

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.setSessionName).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(HANDOFF_STALE_SESSION_MESSAGE, "error");
  });

  it("starts the session when the preview expires unanswered, like the TUI countdown", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, pi } = createRpcReviewHarness(async () => {
        vi.advanceTimersByTime(8_000);
        return undefined;
      });

      await consumeBootstrap(pi, ctx);

      expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
      expect(pi.sendMessage).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

function createRpcReviewHarness(select: () => Promise<string | undefined>) {
  vi.spyOn(SessionManager, "open").mockReturnValue({
    getSessionId: () => "parent-session",
    getSessionName: () => "Parent",
  } as never);
  generateHandoffDraftMock.mockResolvedValue({
    draft: "Generated handoff draft",
    context: { summary: "Relevant context.", relevantFiles: [], openQuestions: [] },
    sessionId: "parent-session",
  });
  const entries: unknown[] = [
    {
      type: "custom",
      id: "bootstrap-1",
      parentId: null,
      timestamp: "2026-03-23T00:00:00.000Z",
      customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
      data: createChildGeneratedHandoffBootstrap({
        sessionId: "child-session",
        briefing: "Finish phase 1",
        title: "Finish phase 1",
        parentSessionFile: "/tmp/parent.jsonl",
        sourceLeafId: "source-leaf",
        reportBack: false,
        bootstrapMode: "review",
        launch: "deferred",
      }),
    },
  ];
  const ctx = {
    hasUI: true,
    mode: "rpc",
    cwd: "/tmp/project",
    modelRegistry: {},
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setEditorText: vi.fn(),
      // Pi's RPC mode resolves custom() at once without rendering anything.
      custom: vi.fn(async () => undefined),
      select:
        vi.fn<(title: string, options: string[], opts?: unknown) => Promise<string | undefined>>(
          select,
        ),
      editor: vi.fn<(title: string, prefill?: string) => Promise<string | undefined>>(),
    },
    sessionManager: {
      getSessionId: () => "child-session",
      getBranch: () => entries,
      getEntries: () => entries,
    },
    shutdown: vi.fn(),
  };
  const pi = {
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    sendMessage: vi.fn(),
  };
  return { ctx, pi, entries };
}
