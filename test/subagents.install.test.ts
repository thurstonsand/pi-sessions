import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHandoffKickoffMessage } from "../extensions/session-handoff/kickoff.ts";
import {
  HANDOFF_BOOTSTRAP_CONSUMED_CUSTOM_TYPE,
  HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
  HANDOFF_METADATA_CUSTOM_TYPE,
} from "../extensions/session-handoff/metadata.ts";
import type { MessagingHandle } from "../extensions/session-messaging/install.ts";
import type {
  CancelSessionResult,
  SendMessageResult,
  SendSubagentReportResult,
} from "../extensions/session-messaging/pi/service.ts";
import { installSubagents } from "../extensions/subagents/install.ts";
import {
  SUBAGENT_CANCELLED_CUSTOM_TYPE,
  SUBAGENT_LAUNCHED_CUSTOM_TYPE,
  SUBAGENT_REPORT_CUSTOM_TYPE,
  SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
  SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
} from "../extensions/subagents/ledger.ts";
import { renderSubagentReportMessage } from "../extensions/subagents/report-message-renderer.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-subagent-install-");
const childSessionFiles = new WeakMap<unknown[], { parentPath: string; childPath: string }>();
const parentId = "12345678-1234-1234-1234-123456789abc";
const childId = "87654321-1234-1234-1234-123456789abc";

function createPromptEvent() {
  return {
    systemPrompt: "Old rendered prompt",
    systemPromptOptions: {
      sections: { other_extension: "Current instructions" } as Record<string, string>,
    },
  };
}
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
    const envelope = {
      kind: "subagent_report" as const,
      reportId: "report-1",
      source: childId,
      target: parentId,
      status: "done" as const,
      summary: "Complete.",
      sentAt: "2026-03-25T00:00:00.000Z",
    };
    await receive?.(envelope);
    await receive?.(envelope);

    expect(order).toEqual(["receipt", "message"]);
    expect(listSessions).not.toHaveBeenCalled();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
      expect.objectContaining({ reportId: "report-1", childSessionId: childId }),
    );
  });

  it("redirects only unfinished subagents launched on the active branch", async () => {
    const { pi } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));

    expect(await handle.shouldMessageSubagent(childId)).toBe(false);

    await handle.onSessionStart?.(
      { type: "session_start", reason: "startup" },
      createContext(parentId, [launchEntry()]) as never,
    );

    expect(await handle.shouldMessageSubagent(childId)).toBe(true);
    expect(await handle.shouldMessageSubagent(grandchildId)).toBe(false);
  });

  it("stops redirecting once the active branch no longer carries the launch", async () => {
    const { pi } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));

    await handle.onSessionStart?.(
      { type: "session_start", reason: "startup" },
      createContext(parentId, [launchEntry()]) as never,
    );
    expect(await handle.shouldMessageSubagent(childId)).toBe(true);

    handle.onSessionShutdown?.(
      { type: "session_shutdown", reason: "reload" },
      createContext(parentId, []) as never,
    );
    await handle.onSessionStart?.(
      { type: "session_start", reason: "reload" },
      createContext(parentId, []) as never,
    );

    expect(await handle.shouldMessageSubagent(childId)).toBe(false);
  });

  it("allows transcript questions for a cancelled subagent", async () => {
    const { pi } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));

    await handle.onSessionStart?.(
      { type: "session_start", reason: "startup" },
      createContext(parentId, [launchEntry(), cancelEntry()]) as never,
    );

    expect(await handle.shouldMessageSubagent(childId)).toBe(false);
  });

  it.each([
    { hasWindow: false, brokerLive: false, redirect: false },
    { hasWindow: true, brokerLive: false, redirect: true },
    { hasWindow: false, brokerLive: true, redirect: true },
  ])(
    "classifies a reported child without waking it: %j",
    async ({ hasWindow, brokerLive, redirect }) => {
      const { pi } = createPi({
        tmuxInstalled: true,
        ownedWindowSessionIds: () => (hasWindow ? [childId] : []),
      });
      const listSessions = vi.fn(async () => (brokerLive ? [childId] : []));
      const handle = installSubagents(pi as never, createDeps(2, undefined, listSessions));
      const entries: unknown[] = [];
      await handle.onSessionStart?.(
        { type: "session_start", reason: "startup" },
        createContext(parentId, entries) as never,
      );
      const childPath = testFs.writeJsonlFile(testFs.createTempDir(), "reported.jsonl", [
        {
          type: "session",
          version: 3,
          id: childId,
          timestamp: "2026-03-25T00:00:00.000Z",
          cwd: "/repo",
        },
        {
          type: "custom",
          id: "report",
          parentId: null,
          timestamp: "2026-03-25T00:00:01.000Z",
          customType: SUBAGENT_REPORT_CUSTOM_TYPE,
          data: { reportId: "report-1", status: "done", summary: "Complete." },
        },
      ]);
      const launch = launchEntry();
      launch.data.childSessionFile = childPath;
      entries.push(launch);
      pi.exec.mockClear();
      pi.appendEntry.mockClear();
      pi.sendMessage.mockClear();

      expect(await handle.shouldMessageSubagent(childId)).toBe(redirect);
      expect(pi.appendEntry).not.toHaveBeenCalled();
      expect(pi.sendMessage).not.toHaveBeenCalled();
      expect(pi.exec.mock.calls.every(([, args]) => args[0] === "list-windows")).toBe(true);
    },
  );

  it("resolves the owning parent without registering peer messaging", async () => {
    const { pi } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));

    await handle.onSessionStart?.(
      { type: "session_start", reason: "startup" },
      createContext(childId, childEntries(1, true)) as never,
    );

    expect(handle.getParentSessionId()).toBe(parentId);
    expect(
      pi.registerTool.mock.calls.map((call) => (call[0] as ToolDefinition).name),
    ).not.toContain("session_send_message");
  });

  it("provides a working report tool when a rewind arms the parent refusal", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const messaging = createMessagingFake(undefined, async () => []);
    vi.mocked(messaging.sendSubagentReport).mockResolvedValue({ delivered: true });
    const handle = installSubagents(
      pi as never,
      createDeps(2, undefined, undefined, undefined, messaging),
    );
    const entries = pendingChildEntries(1, true);
    entries.push({
      type: "custom",
      id: "consumed",
      parentId: "bootstrap",
      customType: HANDOFF_BOOTSTRAP_CONSUMED_CUSTOM_TYPE,
      data: { bootstrapEntryId: "bootstrap", reason: "cancelled" },
    });
    const ctx = createContext(childId, entries);
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
    expect(handle.getParentSessionId()).toBeUndefined();
    expect(pi.getActiveTools()).not.toContain("submit_task_report");

    entries.pop();
    await handlers.get("session_tree")?.({}, ctx);

    expect(handle.getParentSessionId()).toBe(parentId);
    expect(pi.getActiveTools()).toContain("submit_task_report");
    const report = registeredTool(pi, "submit_task_report");
    const result = await report.execute(
      "report-1",
      { status: "done", summary: "Rewind report." },
      undefined,
      undefined,
      ctx as never,
    );
    expect(result).toMatchObject({ terminate: true, details: { delivered: true } });
    expect(pi.appendEntry).toHaveBeenCalledWith(
      SUBAGENT_REPORT_CUSTOM_TYPE,
      expect.objectContaining({ status: "done", summary: "Rewind report." }),
    );
    expect(messaging.sendSubagentReport).toHaveBeenCalledWith(
      expect.objectContaining({ target: parentId, summary: "Rewind report." }),
    );

    entries.length = 0;
    await handlers.get("session_tree")?.({}, ctx);
    expect(handle.getParentSessionId()).toBeUndefined();
    expect(pi.getActiveTools()).not.toContain("submit_task_report");
    const event = createPromptEvent();
    expect(await handlers.get("before_agent_start")?.(event, ctx)).toBeUndefined();
    expect(event.systemPromptOptions.sections.pi_sessions_subagent).toBeUndefined();
    await expect(
      report.execute(
        "report-2",
        { status: "done", summary: "Invalid." },
        undefined,
        undefined,
        ctx as never,
      ),
    ).rejects.toThrow("submit_task_report is available only in its original subagent session.");

    entries.push(...pendingChildEntries(1, true));
    await handlers.get("session_tree")?.({}, ctx);
    expect(pi.getActiveTools()).toContain("submit_task_report");
  });

  it("preserves turn report accounting when navigating within the same child identity", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const entries = childEntries(1, true);
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, entries);
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
    await handlers.get("agent_start")?.({}, ctx);
    entries.push({
      type: "custom",
      id: "report",
      parentId: "kickoff",
      customType: SUBAGENT_REPORT_CUSTOM_TYPE,
      data: { reportId: "report-1", status: "done", summary: "Complete." },
    });
    await handlers.get("session_tree")?.({}, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    expect(ctx.shutdown).toHaveBeenCalledOnce();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("resets the report baseline when rewinding behind reports counted at turn start", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const entries = childEntries(1, true);
    const report = {
      type: "custom",
      id: "report",
      parentId: "kickoff",
      customType: SUBAGENT_REPORT_CUSTOM_TYPE,
      data: { reportId: "report-1", status: "done", summary: "Complete." },
    };
    entries.push(report);
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, entries);
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
    await handlers.get("agent_start")?.({}, ctx);
    entries.pop();
    await handlers.get("session_tree")?.({}, ctx);
    entries.push(report);
    await handlers.get("agent_settled")?.({}, ctx);
    expect(ctx.shutdown).toHaveBeenCalledOnce();
    expect(pi.sendMessage).not.toHaveBeenCalled();
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

  it("adds a named section without freezing another extension's prompt", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, pendingChildEntries(1, true));

    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
    const event = createPromptEvent();
    expect(await handlers.get("before_agent_start")?.(event, ctx)).toBeUndefined();

    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "submit_task_report" }),
    );
    expect(event.systemPromptOptions.sections.pi_sessions_subagent).toContain(
      "You are working as a subagent on one task delegated by a parent session.",
    );
    expect(event.systemPromptOptions.sections.pi_sessions_agent_profile).toBeUndefined();
    expect(event.systemPromptOptions.sections.other_extension).toBe("Current instructions");
    expect(event.systemPrompt).toBe("Old rendered prompt");
  });

  it("adds a launched agent profile's instructions to the child's prompt", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));
    const entries = pendingChildEntries(1, true) as Array<{
      data: { subagent: Record<string, unknown> };
    }>;
    const bootstrap = entries[0];
    if (!bootstrap) throw new Error("missing bootstrap");
    bootstrap.data.subagent.agent = { name: "oracle", instructions: "Review; do not edit." };
    const ctx = createContext(childId, entries);

    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
    const event = createPromptEvent();
    await handlers.get("before_agent_start")?.(event, ctx);

    expect(event.systemPromptOptions.sections.pi_sessions_subagent).toContain(
      "You are working as a subagent",
    );
    expect(event.systemPromptOptions.sections.pi_sessions_agent_profile).toBe(
      "Review; do not edit.",
    );
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
    const event = createPromptEvent();
    expect(await handlers.get("before_agent_start")?.(event, ctx)).toBeUndefined();
    expect(event.systemPromptOptions.sections.pi_sessions_subagent).toBeUndefined();
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
    const event = createPromptEvent();
    expect(await handlers.get("before_agent_start")?.(event, ctx)).toBeUndefined();
    expect(event.systemPromptOptions.sections.pi_sessions_subagent).toBeUndefined();
    expect(pi.registerTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "submit_task_report" }),
    );
  });

  it("gives fire-and-forget children scope guidance without report instructions", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, childEntries(1, false));
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);

    const event = createPromptEvent();
    await handlers.get("before_agent_start")?.(event, ctx);

    expect(event.systemPromptOptions.sections.pi_sessions_subagent).toContain(
      "You are working as a subagent on one task delegated by a parent session.",
    );
    expect(event.systemPromptOptions.sections.pi_sessions_subagent).not.toContain(
      "submit_task_report",
    );
  });

  it.each([
    ["an established bootstrap", () => childEntries(1, true)],
    ["a pending bootstrap", () => pendingChildEntries(1, true)],
  ])("treats a fork that inherited %s under a fresh id as ordinary", async (_source, entries) => {
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext("11111111-1234-1234-1234-123456789abc", entries());
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);

    const event = createPromptEvent();
    expect(await handlers.get("before_agent_start")?.(event, ctx)).toBeUndefined();
    expect(event.systemPromptOptions.sections.pi_sessions_subagent).toBeUndefined();
    expect(pi.registerTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "submit_task_report" }),
    );
  });

  it("does not duplicate report-tool guidance in the subagent system addition", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, childEntries(1, true));
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);

    const event = createPromptEvent();
    await handlers.get("before_agent_start")?.(event, ctx);

    expect(event.systemPromptOptions.sections.pi_sessions_subagent).not.toContain(
      "submit_task_report",
    );
  });

  it("compacts an over-limit child before settling it, and leaves the parent alone", async () => {
    const order: string[] = [];
    const { pi, handlers } = createPi({ tmuxInstalled: true, attachedResponses: [false] });
    const handle = installSubagents(pi as never, createDeps(2, undefined, undefined, 400_000));
    const ctx = createContext(childId, childEntries(1, false));
    ctx.compact.mockImplementation((options: { onComplete?: () => void }) => {
      order.push("compact");
      options.onComplete?.();
    });
    ctx.shutdown.mockImplementation(() => order.push("shutdown"));
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);

    await handlers.get("agent_settled")?.({}, ctx);
    expect(order).toEqual(["compact", "shutdown"]);

    const parentCtx = createContext(parentId, []);
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, parentCtx as never);
    await handlers.get("agent_settled")?.({}, parentCtx);
    expect(parentCtx.compact).not.toHaveBeenCalled();
  });

  it("leaves an under-limit child uncompacted", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true, attachedResponses: [false] });
    const handle = installSubagents(pi as never, createDeps(2, undefined, undefined, 400_000));
    const ctx = createContext(childId, childEntries(1, false));
    ctx.getContextUsage = () => ({ tokens: 100_000, contextWindow: 1_000_000, percent: 10 });
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);

    await handlers.get("agent_settled")?.({}, ctx);

    expect(ctx.compact).not.toHaveBeenCalled();
    expect(ctx.shutdown).toHaveBeenCalledOnce();
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

  it("pauses an escaped child turn until a settle that was not aborted", async () => {
    const { pi, handlers } = createPi({ tmuxInstalled: true, attachedResponses: [false] });
    const entries = childEntries(1, true);
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, entries);
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
    await handlers.get("agent_start")?.({}, ctx);
    await handlers.get("agent_settled")?.({ aborted: true }, ctx);
    await handlers.get("agent_start")?.({}, ctx);
    entries.push({
      type: "custom",
      id: "report",
      parentId: "kickoff",
      customType: SUBAGENT_REPORT_CUSTOM_TYPE,
      data: { reportId: "report-1", status: "done", summary: "Complete." },
    });
    await handlers.get("agent_settled")?.({ aborted: true }, ctx);
    await handlers.get("agent_start")?.({}, ctx);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(ctx.shutdown).not.toHaveBeenCalled();

    await handlers.get("agent_settled")?.({ aborted: false }, ctx);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(ctx.shutdown).toHaveBeenCalledOnce();
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

  describe.each([
    { boundary: "settled", reportCount: 1 },
    { boundary: "settled", reportCount: 2 },
    { boundary: "owned-subagent poll", reportCount: 1 },
    { boundary: "owned-subagent poll", reportCount: 2 },
  ])("$reportCount recovered reports during $boundary", ({ boundary, reportCount }) => {
    it.each([
      { name: "fire-and-forget", requestResponse: false, reported: false, reminded: false },
      { name: "already reported", requestResponse: true, reported: true, reminded: false },
      { name: "no report", requestResponse: true, reported: false, reminded: false },
      { name: "already reminded", requestResponse: true, reported: false, reminded: true },
    ])("lets a $name child process the recovered report before settling", async (scenario) => {
      vi.useFakeTimers();
      let grandchildRunning = boundary === "owned-subagent poll";
      const entries = childEntriesWithGrandchild(scenario.requestResponse);
      const launch = entries.at(-1) as { data: { childSessionFile: string } };
      const { pi, handlers } = createPi({
        tmuxInstalled: true,
        ownedWindowSessionIds: () => (grandchildRunning ? [grandchildId] : []),
      });
      const deferred: Array<{
        customType: string;
        content: string;
        display: boolean;
        details: unknown;
      }> = [];
      pi.sendMessage.mockImplementation((message) => deferred.push(message));
      pi.appendEntry.mockImplementation((customType, data) => {
        entries.push({ type: "custom", id: `entry-${entries.length}`, customType, data });
      });
      const handle = installSubagents(pi as never, createDeps(2));
      const ctx = createContext(childId, entries);
      await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
      await handlers.get("agent_start")?.({}, ctx);
      if (scenario.reported) {
        entries.push({
          type: "custom",
          customType: SUBAGENT_REPORT_CUSTOM_TYPE,
          data: { reportId: "child-report-1", status: "done", summary: "Initial result." },
        });
      }
      if (scenario.reminded) {
        entries.push({
          type: "custom_message",
          customType: "pi-sessions.report_reminder_message",
          content: "Submit a report.",
          display: true,
        });
      }
      if (grandchildRunning) {
        await handlers.get("agent_settled")?.({}, ctx);
      }
      for (let index = 0; index < reportCount; index += 1) {
        appendFileSync(
          launch.data.childSessionFile,
          `${JSON.stringify({
            type: "custom",
            id: `grandchild-report-${index}`,
            parentId: index === 0 ? "grandchild-closed" : `grandchild-report-${index - 1}`,
            timestamp: "2026-03-25T00:00:07.000Z",
            customType: SUBAGENT_REPORT_CUSTOM_TYPE,
            data: {
              reportId: `grandchild-report-${index}`,
              status: "done",
              summary: "Recovered result.",
            },
          })}\n`,
        );
      }
      grandchildRunning = false;

      if (boundary === "owned-subagent poll") {
        await vi.advanceTimersByTimeAsync(10_000);
      } else {
        await handlers.get("agent_settled")?.({}, ctx);
      }

      // Pi 0.87 leaves both checks unchanged until all settled handlers return.
      expect(ctx.isIdle()).toBe(true);
      expect(ctx.hasPendingMessages()).toBe(false);
      expect(pi.sendMessage).toHaveBeenCalledTimes(reportCount);
      for (let index = 0; index < reportCount; index += 1) {
        expect(pi.sendMessage).toHaveBeenNthCalledWith(
          index + 1,
          expect.objectContaining({ customType: SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE }),
          { triggerTurn: true },
        );
      }
      expect(pi.appendEntry).not.toHaveBeenCalledWith(
        "pi-sessions.subagent_closed",
        expect.anything(),
      );
      expect(ctx.shutdown).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      for (let index = 0; index < reportCount; index += 1) {
        const recovered = deferred.shift();
        expect(recovered?.customType).toBe(SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE);
        ctx.isIdle = () => false;
        await handlers.get("agent_start")?.({}, ctx);
        await handlers.get("message_end")?.({ message: { role: "custom", ...recovered } }, ctx);
        entries.push({ type: "custom_message", ...recovered });
        if (scenario.requestResponse) {
          entries.push({
            type: "custom",
            customType: SUBAGENT_REPORT_CUSTOM_TYPE,
            data: {
              reportId: `child-followup-${index}`,
              status: "done",
              summary: "Includes recovered result.",
            },
          });
        }
        ctx.isIdle = () => true;
        await handlers.get("agent_settled")?.({}, ctx);
        if (deferred.length > 0) {
          expect(ctx.shutdown).not.toHaveBeenCalled();
          expect(pi.appendEntry).not.toHaveBeenCalledWith(
            "pi-sessions.subagent_closed",
            expect.anything(),
          );
        }
      }

      expect(ctx.shutdown).toHaveBeenCalledOnce();
      expect(pi.sendMessage).toHaveBeenCalledTimes(reportCount);
      expect(deferred).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });
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

  it("reports reconciliation failures without throwing from hooks or poll timers", async () => {
    vi.useFakeTimers();
    let tmuxBroken = false;
    const { pi, handlers } = createPi({
      tmuxInstalled: true,
      ownedWindowSessionIds: () => [grandchildId],
      listWindowsError: () => (tmuxBroken ? "protocol version mismatch" : undefined),
    });
    const handle = installSubagents(pi as never, createDeps(2));
    const ctx = createContext(childId, childEntriesWithGrandchild());
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);
    await handlers.get("agent_settled")?.({}, ctx);

    tmuxBroken = true;
    await vi.advanceTimersByTimeAsync(10_000);
    await handlers.get("agent_settled")?.({}, ctx);
    await handlers.get("session_tree")?.({}, ctx);
    await handle.onSessionShutdown?.({ type: "session_shutdown", reason: "quit" }, ctx as never);
    await handle.onSessionStart?.({ type: "session_start", reason: "startup" }, ctx as never);

    expect(ctx.ui.notify.mock.calls).toEqual(
      Array.from({ length: 5 }, () => [
        "Subagent lifecycle failed: Failed to list windows with tmux: protocol version mismatch",
        "error",
      ]),
    );
    expect(ctx.shutdown).not.toHaveBeenCalled();
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
  listSessions: () => Promise<string[]> = vi.fn(async () => []),
  contextLimit?: number,
  messaging = createMessagingFake(captureIncoming, listSessions),
) {
  return {
    readCompactionSettings: () => ({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    }),
    settings: { subagents: { maxDepth, contextLimit } },
    index: { path: "/tmp/index.sqlite" },
    messaging,
    sendMessage: messaging.sendMessage,
  } as never;
}

function createMessagingFake(
  captureIncoming: ((handler: (envelope: unknown) => void) => void) | undefined,
  listSessions: () => Promise<string[]>,
): MessagingHandle {
  return {
    onIncomingSubagentReport: vi.fn((handler) => captureIncoming?.(handler as never)),
    onIncomingMessage: vi.fn(),
    onIncomingCancel: vi.fn(),
    sendSubagentReport: vi.fn(
      async (): Promise<SendSubagentReportResult> => ({
        delivered: false,
        reason: "no_session",
      }),
    ),
    sendMessage: vi.fn(
      async (): Promise<SendMessageResult> => ({
        delivered: false,
        messageId: "message-1",
        reason: "no_session",
      }),
    ),
    cancelSession: vi.fn(
      async (): Promise<CancelSessionResult> => ({
        kind: "transport",
        cancelId: "cancel-1",
        delivered: false,
        reason: "no_session",
      }),
    ),
    waitForSession: vi.fn(async () => false),
    getCachedRelationTo: vi.fn(() => undefined),
    listSessions,
  };
}

function createPi(options: {
  tmuxInstalled: boolean;
  attachedResponses?: boolean[];
  ownedWindowSessionIds?: () => readonly string[];
  listWindowsError?: () => string | undefined;
}) {
  const handlers = new Map<
    string,
    (event: unknown, ctx: ReturnType<typeof createContext>) => unknown
  >();
  const attachedResponses = [...(options.attachedResponses ?? [])];
  let activeTools = ["read", "bash"];
  const knownTools = new Set(activeTools);
  const pi = {
    registerTool: vi.fn((tool: ToolDefinition) => {
      if (!knownTools.has(tool.name)) {
        knownTools.add(tool.name);
        activeTools.push(tool.name);
      }
    }),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((names: string[]) => {
      activeTools = names;
    }),
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
        const error = options.listWindowsError?.();
        if (error) {
          return { code: 1, stdout: "", stderr: error };
        }
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

function registeredTool(pi: ReturnType<typeof createPi>["pi"], name: string): ToolDefinition {
  const tool = pi.registerTool.mock.calls
    .map(([tool]) => tool)
    .findLast((tool) => tool.name === name);
  if (!tool) {
    throw new Error(`${name} was not registered.`);
  }
  return tool;
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
    hasUI: false,
    ui: { notify: vi.fn() },
    getContextUsage: () => ({ tokens: 500_000, contextWindow: 1_000_000, percent: 50 }),
    compact: vi.fn((options: { onComplete?: () => void }) => options.onComplete?.()),
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

function cancelEntry() {
  return {
    type: "custom",
    id: "cancelled",
    parentId: "launch",
    customType: SUBAGENT_CANCELLED_CUSTOM_TYPE,
    data: { writerSessionId: parentId, childSessionId: childId },
  };
}

function childEntriesWithGrandchild(requestResponse = true): unknown[] {
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
  const entries = childEntries(1, requestResponse);
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
