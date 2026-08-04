import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHandoffKickoffMessage } from "../extensions/session-handoff/kickoff.ts";
import {
  HANDOFF_BOOTSTRAP_CONSUMED_CUSTOM_TYPE,
  HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
  HANDOFF_METADATA_CUSTOM_TYPE,
} from "../extensions/session-handoff/metadata.ts";
import { installSubagents } from "../extensions/subagents/install.ts";
import {
  SUBAGENT_LAUNCHED_CUSTOM_TYPE,
  SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
  SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
} from "../extensions/subagents/ledger.ts";
import { renderSubagentReportMessage } from "../extensions/subagents/report-message-renderer.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-subagent-install-");
const childSessionFiles = new WeakMap<unknown[], { parentPath: string; childPath: string }>();
const parentId = "12345678-1234-1234-1234-123456789abc";
const childId = "87654321-1234-1234-1234-123456789abc";
const grandchildId = "aaaaaaaa-1234-1234-1234-123456789abc";

afterEach(() => {
  vi.useRealTimers();
  testFs.cleanup();
});

describe("subagent installation", () => {
  it("registers the report-message renderer", () => {
    const { pi } = createPi({ tmuxInstalled: true });

    installSubagents(pi as never, createDeps(2));

    expect(pi.registerMessageRenderer).toHaveBeenCalledWith(
      SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
      renderSubagentReportMessage,
    );
  });

  it("offers launch only when tmux exists and durable depth is below the limit", async () => {
    const { pi } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));

    await handle.onSessionStart?.(
      { type: "session_start", reason: "startup" },
      createContext(parentId, []) as never,
    );
    expect(handle.getLaunchTargets().map((target) => target.value)).toEqual(["subagent"]);

    handle.onSessionShutdown?.(
      { type: "session_shutdown", reason: "reload" },
      createContext(parentId, []) as never,
    );
    await handle.onSessionStart?.(
      { type: "session_start", reason: "reload" },
      createContext(childId, childEntries(2)) as never,
    );
    expect(handle.getLaunchTargets()).toEqual([]);
  });

  it("does not offer launch when tmux is unavailable", async () => {
    const { pi } = createPi({ tmuxInstalled: false });
    const handle = installSubagents(pi as never, createDeps(2));

    await handle.onSessionStart?.(
      { type: "session_start", reason: "startup" },
      createContext(parentId, []) as never,
    );
    expect(handle.getLaunchTargets()).toEqual([]);
  });

  it("persists an incoming report before making it model-visible", async () => {
    const order: string[] = [];
    const listSessions = vi.fn(async () => []);
    let receive: ((envelope: unknown) => void) | undefined;
    const { pi } = createPi({ tmuxInstalled: true });
    pi.appendEntry.mockImplementation(() => order.push("receipt"));
    pi.sendMessage.mockImplementation(() => order.push("message"));
    const handle = installSubagents(
      pi as never,
      createDeps(
        2,
        (handler) => {
          receive = handler;
        },
        listSessions,
      ),
    );
    await handle.onSessionStart?.(
      { type: "session_start", reason: "startup" },
      createContext(parentId, [launchEntry()]) as never,
    );

    listSessions.mockClear();
    receive?.({
      kind: "subagent_report",
      reportId: "report-1",
      source: childId,
      target: parentId,
      status: "done",
      summary: "Complete.",
      sentAt: "2026-03-25T00:00:00.000Z",
    });

    expect(order).toEqual(["receipt", "message"]);
    expect(listSessions).not.toHaveBeenCalled();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
      expect.objectContaining({ reportId: "report-1", childSessionId: childId }),
    );
  });

  it("skips reconciliation when a plain session settles without subagent history", async () => {
    const listSessions = vi.fn(async () => []);
    const deps = createDeps(2, undefined, listSessions);
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, deps);
    const ctx = createContext(parentId, []);
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
    pi.exec.mockClear();
    listSessions.mockClear();

    await handlers.get("agent_settled")?.({}, ctx);

    expect(pi.exec).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("does not reconcile ordinary sends to unrelated sessions", async () => {
    const deps = createDeps(2);
    const { pi } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, deps);
    const ctx = createContext(parentId, []);
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
    pi.exec.mockClear();

    await handle.sendMessage({ target: "unrelated", body: "hello" });

    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("recognizes a child from its pending bootstrap before handoff metadata exists", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, pendingChildEntries(1, true));

    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
    const result = await handlers.get("before_agent_start")?.({ systemPrompt: "Base prompt" }, ctx);

    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "submit_task_report" }),
    );
    expect(result).toEqual({
      systemPrompt: expect.stringContaining(
        "You are working as a subagent on one task delegated by a parent session.",
      ),
    });
  });

  it("does not recognize a child from a cancelled bootstrap", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));
    const entries = [
      ...pendingChildEntries(1, true),
      {
        type: "custom",
        id: "consumed",
        parentId: "bootstrap",
        timestamp: "2026-03-25T00:00:03.000Z",
        customType: HANDOFF_BOOTSTRAP_CONSUMED_CUSTOM_TYPE,
        data: { bootstrapEntryId: "bootstrap", reason: "cancelled" },
      },
    ];
    const ctx = createContext(childId, entries);

    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
    const result = await handlers.get("before_agent_start")?.({ systemPrompt: "Base prompt" }, ctx);

    expect(result).toBeUndefined();
    expect(pi.registerTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "submit_task_report" }),
    );
  });

  it("does not recognize a child from a stale bootstrap", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));
    const entries = [
      ...pendingChildEntries(1, true),
      {
        type: "message",
        id: "user-message",
        parentId: "bootstrap",
        timestamp: "2026-03-25T00:00:03.000Z",
        message: { role: "user", content: "This session already started." },
      },
    ];
    const ctx = createContext(childId, entries);

    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
    const result = await handlers.get("before_agent_start")?.({ systemPrompt: "Base prompt" }, ctx);

    expect(result).toBeUndefined();
    expect(pi.registerTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "submit_task_report" }),
    );
  });

  it("gives fire-and-forget children scope guidance without report instructions", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, childEntries(1, false));
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);

    const result = await handlers.get("before_agent_start")?.({ systemPrompt: "Base prompt" }, ctx);

    expect(result).toEqual({
      systemPrompt: expect.stringContaining(
        "You are working as a subagent on one task delegated by a parent session.",
      ),
    });
    expect((result as { systemPrompt: string }).systemPrompt).not.toContain("submit_task_report");
  });

  it.each([
    ["an established bootstrap", () => childEntries(1, true)],
    ["a pending bootstrap", () => pendingChildEntries(1, true)],
  ])("treats a fork that inherited %s under a fresh id as ordinary", async (_source, entries) => {
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext("11111111-1234-1234-1234-123456789abc", entries());
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);

    const result = await handlers.get("before_agent_start")?.({ systemPrompt: "Base prompt" }, ctx);

    expect(result).toBeUndefined();
    expect(pi.registerTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "submit_task_report" }),
    );
  });

  it("does not duplicate report-tool guidance in the subagent system addition", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, childEntries(1, true));
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);

    const result = await handlers.get("before_agent_start")?.({ systemPrompt: "Base prompt" }, ctx);

    expect((result as { systemPrompt: string }).systemPrompt).not.toContain("submit_task_report");
  });

  it("exits a settled child immediately when nobody is observing its tmux session", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true, attachedResponses: [false] });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, childEntries(1, false));
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);

    await handlers.get("agent_settled")?.({}, ctx);
    expect(ctx.shutdown).toHaveBeenCalledOnce();
  });

  it("exits after a response-requested child submits a report", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true, attachedResponses: [false] });
    const entries = childEntries(1, true);
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, entries);
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
    await handlers.get("agent_start")?.({}, ctx);
    entries.push({
      type: "custom",
      id: "report",
      parentId: "identity",
      customType: "pi-sessions.subagent_report",
      data: { reportId: "report-1", status: "done", summary: "Complete." },
    } as never);

    await handlers.get("agent_settled")?.({}, ctx);

    expect(ctx.shutdown).toHaveBeenCalledOnce();
    expect(pi.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pi-sessions.report_reminder_message" }),
      expect.anything(),
    );
  });

  it("keeps a settled child resident without a reminder while its owned subagent runs", async () => {
    vi.useFakeTimers();
    const entries = childEntriesWithGrandchild();
    const listSessions = vi.fn(async () => []);
    const { pi, handlers } = createPi({
      tmuxInstalled: true,
      ownedWindowSessionIds: () => [grandchildId],
    });
    const handle = installSubagents(pi as never, createDeps(2, undefined, listSessions));
    const ctx = createContext(childId, entries);
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
    pi.sendMessage.mockClear();

    await handlers.get("agent_settled")?.({}, ctx);
    listSessions.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(listSessions).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pi-sessions.report_reminder_message" }),
      expect.anything(),
    );
    expect(ctx.shutdown).not.toHaveBeenCalled();
  });

  it("keeps a reported child resident while its owned subagent runs", async () => {
    vi.useFakeTimers();
    const entries = childEntriesWithGrandchild();
    const { pi, handlers } = createPi({
      tmuxInstalled: true,
      ownedWindowSessionIds: () => [grandchildId],
    });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, entries);
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
    await handlers.get("agent_start")?.({}, ctx);
    entries.push({
      type: "custom",
      id: "report",
      parentId: "grandchild-launch",
      customType: "pi-sessions.subagent_report",
      data: { reportId: "report-1", status: "done", summary: "Complete." },
    } as never);

    await handlers.get("agent_settled")?.({}, ctx);

    expect(pi.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pi-sessions.report_reminder_message" }),
      expect.anything(),
    );
    expect(ctx.shutdown).not.toHaveBeenCalled();
  });

  it("kicks a waiting child once its owned subagent closes without a report", async () => {
    vi.useFakeTimers();
    let grandchildRunning = true;
    const entries = childEntriesWithGrandchild();
    const { pi, handlers } = createPi({
      tmuxInstalled: true,
      ownedWindowSessionIds: () => (grandchildRunning ? [grandchildId] : []),
    });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, entries);
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);

    await handlers.get("agent_settled")?.({}, ctx);
    grandchildRunning = false;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pi-sessions.report_reminder_message" }),
      { triggerTurn: true },
    );
    expect(ctx.shutdown).not.toHaveBeenCalled();
  });

  it("reminds a response-requested child once before closing it reportless", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true, attachedResponses: [false] });
    const entries = childEntries(1, true);
    pi.sendMessage.mockImplementation((message: { customType: string; content: string }) => {
      entries.push({
        type: "custom_message",
        id: `entry-${entries.length}`,
        parentId: (entries.at(-1) as { id?: string } | undefined)?.id ?? null,
        customType: message.customType,
        content: message.content,
        display: true,
      } as never);
    });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, entries);
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);

    await handlers.get("agent_settled")?.({}, ctx);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pi-sessions.report_reminder_message" }),
      { triggerTurn: true },
    );
    expect(ctx.shutdown).not.toHaveBeenCalled();

    await handlers.get("agent_settled")?.({}, ctx);
    expect(pi.appendEntry).toHaveBeenCalledWith("pi-sessions.subagent_closed", {
      reason: "no_report_after_reminder",
    });
    expect(ctx.shutdown).toHaveBeenCalledOnce();
  });

  it("lingers while attached and exits after the observer detaches", async () => {
    vi.useFakeTimers();
    const { pi, handlers } = createPi({
      tmuxInstalled: true,
      attachedResponses: [true, false],
    });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, childEntries(1, false));
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);

    await handlers.get("agent_settled")?.({}, ctx);
    expect(ctx.shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.shutdown).toHaveBeenCalledOnce();
  });
});

function createDeps(
  maxDepth: number,
  captureIncoming?: ((handler: (envelope: unknown) => void) => void) | undefined,
  listSessions = vi.fn(async () => []),
) {
  return {
    settings: { subagents: { maxDepth } },
    index: { path: "/tmp/index.sqlite" },
    messaging: {
      onIncomingSubagentReport: vi.fn((handler) => captureIncoming?.(handler)),
      sendSubagentReport: vi.fn(),
      sendMessage: vi.fn(async () => ({
        delivered: false,
        messageId: "message-1",
        reason: "no_session",
      })),
      listSessions,
    },
  } as never;
}

function createPi(options: {
  tmuxInstalled: boolean;
  attachedResponses?: boolean[];
  ownedWindowSessionIds?: () => readonly string[];
}) {
  const handlers = new Map<
    string,
    (event: unknown, ctx: ReturnType<typeof createContext>) => unknown
  >();
  const attachedResponses = [...(options.attachedResponses ?? [])];
  const pi = {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    on: vi.fn(
      (
        event: string,
        handler: (event: unknown, ctx: ReturnType<typeof createContext>) => unknown,
      ) => {
        handlers.set(event, handler);
      },
    ),
    exec: vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "-V") {
        return { code: options.tmuxInstalled ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args[0] === "list-clients") {
        const attached = attachedResponses.shift() ?? false;
        return { code: 0, stdout: attached ? "/dev/ttys001\n" : "", stderr: "" };
      }
      if (args[0] === "list-windows") {
        const windows = options.ownedWindowSessionIds?.() ?? [];
        return {
          code: 0,
          stdout: windows
            .map((sessionId, index) => `@${index + 1}\tChild\t${sessionId}\n`)
            .join(""),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    }),
  };
  return { pi, handlers };
}

function createContext(sessionId: string, entries: unknown[]) {
  return {
    cwd: "/repo",
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
      getEntries: () => entries,
      getHeader: () => {
        const files = childSessionFiles.get(entries);
        return files ? { parentSession: files.parentPath } : undefined;
      },
      getSessionFile: () => childSessionFiles.get(entries)?.childPath,
    },
    hasPendingMessages: () => false,
    isIdle: () => true,
    shutdown: vi.fn(),
  };
}

function launchEntry() {
  return {
    type: "custom",
    id: "launch",
    parentId: null,
    customType: SUBAGENT_LAUNCHED_CUSTOM_TYPE,
    data: {
      writerSessionId: parentId,
      childSessionId: childId,
      childSessionFile: "/tmp/child.jsonl",
      title: "Child",
      goal: "Work",
      requestResponse: true,
      model: "openai/gpt-5.4",
      cwd: "/repo",
      resumeCommand: "resume",
      depth: 1,
    },
  };
}

function childEntriesWithGrandchild(): unknown[] {
  const root = testFs.createTempDir();
  const grandchildPath = testFs.writeJsonlFile(root, "grandchild.jsonl", [
    {
      type: "session",
      id: grandchildId,
      timestamp: "2026-03-25T00:00:05.000Z",
      cwd: "/repo",
    },
    {
      type: "custom",
      id: "grandchild-closed",
      parentId: null,
      timestamp: "2026-03-25T00:00:06.000Z",
      customType: "pi-sessions.subagent_closed",
      data: { reason: "no_report_after_reminder" },
    },
  ]);
  const entries = childEntries(1, true);
  entries.push({
    type: "custom",
    id: "grandchild-launch",
    parentId: "kickoff",
    timestamp: "2026-03-25T00:00:05.000Z",
    customType: SUBAGENT_LAUNCHED_CUSTOM_TYPE,
    data: {
      writerSessionId: childId,
      childSessionId: grandchildId,
      childSessionFile: grandchildPath,
      title: "Grandchild",
      goal: "Work",
      requestResponse: true,
      cwd: "/repo",
      resumeCommand: "resume",
      depth: 2,
    },
  } as never);
  return entries;
}

function pendingChildEntries(depth: number, requestResponse: boolean): unknown[] {
  return [
    {
      type: "custom",
      id: "bootstrap",
      parentId: null,
      timestamp: "2026-03-25T00:00:02.000Z",
      customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
      data: {
        mode: "generate",
        sessionId: childId,
        goal: "Work",
        title: "Child",
        parentSessionFile: "/tmp/parent.jsonl",
        sourceLeafId: "source-leaf",
        requestResponse,
        bootstrapMode: "automatic",
        launch: "subagent",
        subagent: {
          childSessionId: childId,
          ownerSessionId: parentId,
          depth,
          requestResponse,
        },
      },
    },
  ];
}

function childEntries(depth: number, requestResponse = true): unknown[] {
  const root = testFs.createTempDir();
  const parentPath = join(root, "parent.jsonl");
  const childPath = join(root, "child.jsonl");
  testFs.writeJsonlFile(root, "parent.jsonl", [
    {
      type: "session",
      id: parentId,
      timestamp: "2026-03-25T00:00:00.000Z",
      cwd: "/repo",
    },
    {
      ...launchEntry(),
      timestamp: "2026-03-25T00:00:01.000Z",
      data: {
        ...launchEntry().data,
        childSessionFile: childPath,
        depth,
        requestResponse,
      },
    },
  ]);
  const [bootstrap] = pendingChildEntries(depth, requestResponse);
  const entries: unknown[] = [
    bootstrap,
    {
      type: "custom",
      id: "handoff",
      parentId: "bootstrap",
      timestamp: "2026-03-25T00:00:03.000Z",
      customType: HANDOFF_METADATA_CUSTOM_TYPE,
      data: {
        origin: "handoff",
        goal: "Work",
        title: "Child",
        initial_prompt: "Work",
        launch: "subagent",
      },
    },
    {
      type: "custom_message",
      id: "kickoff",
      parentId: "handoff",
      timestamp: "2026-03-25T00:00:04.000Z",
      ...buildHandoffKickoffMessage({
        prompt: "Work",
        title: "Child",
        source: { sessionId: parentId },
        bootstrapEntryId: "bootstrap",
      }),
    },
  ];
  childSessionFiles.set(entries, { parentPath, childPath });
  return entries;
}
