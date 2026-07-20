import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSubagents } from "../extensions/subagents/install.ts";
import {
  SUBAGENT_LAUNCHED_CUSTOM_TYPE,
  SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
} from "../extensions/subagents/ledger.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-subagent-install-");
const childSessionFiles = new WeakMap<unknown[], { parentPath: string; childPath: string }>();
const parentId = "12345678-1234-1234-1234-123456789abc";
const childId = "87654321-1234-1234-1234-123456789abc";

afterEach(() => {
  vi.useRealTimers();
  testFs.cleanup();
});

describe("subagent installation", () => {
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
    let receive: ((envelope: unknown) => void) | undefined;
    const { pi } = createPi({ tmuxInstalled: true });
    pi.appendEntry.mockImplementation(() => order.push("receipt"));
    pi.sendMessage.mockImplementation(() => order.push("message"));
    const handle = installSubagents(
      pi as never,
      createDeps(2, (handler) => {
        receive = handler;
      }),
    );
    await handle.onSessionStart?.(
      { type: "session_start", reason: "startup" },
      createContext(parentId, [launchEntry()]) as never,
    );

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

  it("tells response-requested children to submit a task report", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, childEntries(1, true));
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);

    const result = await handlers.get("before_agent_start")?.({ systemPrompt: "Base prompt" }, ctx);

    expect((result as { systemPrompt: string }).systemPrompt).toContain(
      "call submit_task_report exactly once as your final action",
    );
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

function createPi(options: { tmuxInstalled: boolean; attachedResponses?: boolean[] }) {
  const handlers = new Map<
    string,
    (event: unknown, ctx: ReturnType<typeof createContext>) => unknown
  >();
  const attachedResponses = [...(options.attachedResponses ?? [])];
  const pi = {
    registerTool: vi.fn(),
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
  const entries: unknown[] = [];
  childSessionFiles.set(entries, { parentPath, childPath });
  return entries;
}
