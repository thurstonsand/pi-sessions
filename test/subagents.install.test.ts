import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_IDENTITY_CUSTOM_TYPE } from "../extensions/subagents/identity.ts";
import { installSubagents } from "../extensions/subagents/install.ts";
import {
  SUBAGENT_LAUNCHED_CUSTOM_TYPE,
  SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
} from "../extensions/subagents/ledger.ts";

const parentId = "12345678-1234-1234-1234-123456789abc";
const childId = "87654321-1234-1234-1234-123456789abc";

afterEach(() => {
  vi.useRealTimers();
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
    const ctx = createContext(childId, childEntries(1));
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);

    await handlers.get("agent_settled")?.({}, ctx);
    expect(ctx.shutdown).toHaveBeenCalledOnce();
  });

  it("lingers while attached and exits after the observer detaches", async () => {
    vi.useFakeTimers();
    const { pi, handlers } = createPi({
      tmuxInstalled: true,
      attachedResponses: [true, false],
    });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, childEntries(1));
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
) {
  return {
    settings: { subagents: { maxDepth } },
    index: { path: "/tmp/index.sqlite" },
    messaging: {
      onIncomingSubagentReport: vi.fn((handler) => captureIncoming?.(handler)),
      sendSubagentReport: vi.fn(),
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

function childEntries(depth: number, requestResponse = true) {
  return [
    {
      type: "custom",
      id: "identity",
      parentId: null,
      customType: SUBAGENT_IDENTITY_CUSTOM_TYPE,
      data: {
        childSessionId: childId,
        ownerSessionId: parentId,
        parentSessionFile: "/tmp/parent.jsonl",
        depth,
        requestResponse,
      },
    },
  ];
}
