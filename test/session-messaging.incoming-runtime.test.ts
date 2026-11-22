import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { buildHandoffKickoffMessage } from "../extensions/session-handoff/kickoff.ts";
import {
  createChildGeneratedHandoffBootstrap,
  HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
  SESSION_STARTING_MESSAGE,
} from "../extensions/session-handoff/metadata.ts";
import { installMessaging } from "../extensions/session-messaging/install.ts";
import {
  IncomingSessionMessageRuntime,
  MESSAGE_RECEIVED_CUSTOM_TYPE,
  SESSION_MESSAGE_CUSTOM_TYPE,
} from "../extensions/session-messaging/pi/incoming-runtime.ts";
import { createSessionCancelTool } from "../extensions/session-messaging/pi/tools.ts";

function pendingBootstrapEntry() {
  return {
    type: "custom",
    id: "bootstrap-1",
    customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
    data: createChildGeneratedHandoffBootstrap({
      sessionId: "child-1",
      briefing: "Finish phase 1",
      title: "Implement autocomplete",
      parentSessionFile: "/tmp/parent.jsonl",
      sourceLeafId: "source-leaf",
      reportBack: false,
      bootstrapMode: "review",
      launch: "deferred",
    }),
  };
}

function receivedMessage() {
  return {
    messageId: "m-1",
    body: "hello",
    source: { sessionId: "parent-1" },
  } as never;
}

test("delivery is refused while a handoff bootstrap is still pending", () => {
  const appendEntry = vi.fn();
  const sendMessage = vi.fn();
  const runtime = new IncomingSessionMessageRuntime({ appendEntry } as never, sendMessage);
  runtime.bindContext({
    sessionManager: { getBranch: () => [pendingBootstrapEntry()] },
  } as never);

  expect(() => runtime.deliver(receivedMessage())).toThrow(SESSION_STARTING_MESSAGE);
  expect(appendEntry).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});

test("delivery proceeds once the kickoff has consumed the bootstrap", () => {
  const appendEntry = vi.fn();
  const sendMessage = vi.fn();
  const runtime = new IncomingSessionMessageRuntime({ appendEntry } as never, sendMessage);
  const kickoff = {
    type: "custom_message",
    id: "kickoff-1",
    ...buildHandoffKickoffMessage({
      prompt: "Approved prompt",
      title: "Implement autocomplete",
      source: { sessionId: "parent-1" },
      bootstrapEntryId: "bootstrap-1",
    }),
  };
  runtime.bindContext({
    isIdle: () => true,
    sessionManager: {
      getBranch: () => [pendingBootstrapEntry(), kickoff],
      getEntries: () => [pendingBootstrapEntry(), kickoff],
    },
  } as never);
  runtime.open();

  runtime.deliver(receivedMessage());
  expect(appendEntry).toHaveBeenCalledOnce();
  expect(sendMessage).toHaveBeenCalledOnce();
});

test("delivery before the session is ready records the receipt and injects it on open", () => {
  const entries: unknown[] = [];
  const appendEntry = vi.fn((customType: string, data: unknown) => {
    entries.push({ type: "custom", customType, data });
  });
  const sendMessage = vi.fn();
  const runtime = new IncomingSessionMessageRuntime({ appendEntry } as never, sendMessage);
  runtime.bindContext({
    isIdle: () => true,
    sessionManager: { getBranch: () => [], getEntries: () => entries },
  } as never);
  const received = {
    messageId: "m-1",
    body: "hello",
    source: { sessionId: "parent-1" },
    target: { sessionId: "child-1" },
    sentAt: "2026-10-08T00:00:00.000Z",
    receivedAt: "2026-10-08T00:00:00.000Z",
    reportBack: true,
  };

  runtime.deliver(received);
  expect(appendEntry).toHaveBeenCalledOnce();
  expect(sendMessage).not.toHaveBeenCalled();

  runtime.open();
  expect(sendMessage).toHaveBeenCalledOnce();
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ details: received }));
});

test("incoming cancellation aborts the target runtime before acceptance", () => {
  const abort = vi.fn();
  const runtime = new IncomingSessionMessageRuntime({ appendEntry: vi.fn() } as never, vi.fn());
  runtime.bindContext({ abort } as never);

  runtime.cancel();
  expect(abort).toHaveBeenCalledOnce();
});

test("session_cancel_turn reports accepted live cancellation", async () => {
  const cancelSession = vi.fn(async () => ({
    kind: "transport" as const,
    delivered: true as const,
    cancelId: "cancel-1",
    target: { sessionId: "target-session", sessionName: "Target" },
    relation: "sibling" as const,
  }));
  const tool = createSessionCancelTool({ cancelSession } as never, {
    name: "session_cancel_turn",
    wording: { description: "Cancel", promptSnippet: "Cancel", promptGuidelines: [] },
  });

  const result = await tool.execute(
    "tool-1",
    { session: "target-session" },
    undefined,
    undefined,
    {} as never,
  );

  expect(cancelSession).toHaveBeenCalledWith("target-session", {});
  expect(result).toMatchObject({
    content: [
      {
        type: "text",
        text: 'Cancellation sent to session "Target" (session: target-session).',
      },
    ],
    details: {
      kind: "transport",
      delivered: true,
      cancelId: "cancel-1",
      target: { sessionId: "target-session", sessionName: "Target" },
      relation: "sibling",
    },
  });
});

test("session_cancel_turn reports managed teardown honestly", async () => {
  const tool = createSessionCancelTool(
    {
      cancelSession: vi.fn(async () => ({
        kind: "managed" as const,
        accepted: true as const,
        target: { sessionId: "child-session", sessionName: "Child" },
        state: "stopping",
      })),
    },
    {
      name: "subagent_cancel",
      wording: { description: "Cancel", promptSnippet: "Cancel", promptGuidelines: [] },
    },
  );

  const result = await tool.execute(
    "tool-2",
    { session: "child-session" },
    undefined,
    undefined,
    {} as never,
  );

  expect(result).toMatchObject({
    content: [
      {
        type: "text",
        text: 'Stop requested for subagent "Child" (session: child-session); it is still shutting down.',
      },
    ],
    details: {
      kind: "managed",
      accepted: true,
      target: { sessionId: "child-session", sessionName: "Child" },
      state: "stopping",
    },
  });
});

test("session_cancel_turn rejects an unknown managed state", async () => {
  const tool = createSessionCancelTool(
    {
      cancelSession: vi.fn(async () => ({
        kind: "managed" as const,
        accepted: true as const,
        target: { sessionId: "child-session", sessionName: "Child" },
        state: "unknown",
      })),
    },
    {
      name: "subagent_cancel",
      wording: { description: "Cancel", promptSnippet: "Cancel", promptGuidelines: [] },
    },
  );

  await expect(
    tool.execute("tool-3", { session: "child-session" }, undefined, undefined, {} as never),
  ).rejects.toThrow('Could not confirm cancellation of subagent "Child".\nsession child-session');
});

test("session_cancel_turn rejects dead targets", async () => {
  const tool = createSessionCancelTool(
    {
      cancelSession: vi.fn(async () => ({
        kind: "transport" as const,
        delivered: false as const,
        cancelId: "cancel-2",
        reason: "no_session" as const,
        error: "No live session found for id: dead-session",
      })),
    } as never,
    {
      name: "session_cancel_turn",
      wording: { description: "Cancel", promptSnippet: "Cancel", promptGuidelines: [] },
    },
  );

  await expect(
    tool.execute("tool-4", { session: "dead-session" }, undefined, undefined, {} as never),
  ).rejects.toThrow(
    "No running session found: dead-session.\nThe target is not an owned subagent and has no broker-live process to cancel.",
  );
});

test("incoming cancellation is rejected until the target runtime is bound", () => {
  const runtime = new IncomingSessionMessageRuntime({ appendEntry: vi.fn() } as never, vi.fn());

  expect(() => runtime.cancel()).toThrow("Target session is not ready.");
});

async function startMessagingAfterSteeredReceipt(mode: "tui" | "rpc") {
  const root = mkdtempSync(join(tmpdir(), "pi-sessions-messaging-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const entries: unknown[] = [];
  const sendMessage = vi.fn();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
      handlers.set(name, handler),
    registerMessageRenderer: () => {},
    sendMessage,
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
  };
  const ctx = {
    mode,
    isIdle: () => true,
    signal: undefined,
    abort: () => {},
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
      getSessionId: () => "target-1",
      getSessionFile: () => undefined,
      getCwd: () => root,
    },
  };
  const messaging = installMessaging(pi as never, {
    settings: {} as never,
    index: { path: join(root, "index.db") },
  });
  await messaging.onSessionStart?.(
    { type: "session_start", reason: "startup" } as never,
    ctx as never,
  );
  await messaging.onSessionReady?.(ctx as never);
  // The receipt was written and its message steered into the running turn; pi then dropped it.
  const received = {
    messageId: "m-1",
    body: "hello",
    source: { sessionId: "peer-1" },
    target: { sessionId: "target-1" },
    sentAt: "2026-11-19T03:00:00.000Z",
    receivedAt: "2026-11-19T03:00:00.100Z",
  };
  entries.push({ type: "custom", customType: MESSAGE_RECEIVED_CUSTOM_TYPE, data: received });
  const settle = async (aborted: boolean) =>
    await handlers.get("agent_settled")?.({ type: "agent_settled", aborted }, ctx);
  const stop = async () => {
    await messaging.onSessionShutdown?.({} as never, ctx as never);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  };
  return { entries, received, sendMessage, settle, stop };
}

test("an interactive abort re-delivers a message its run dropped, once", async () => {
  const session = await startMessagingAfterSteeredReceipt("tui");
  try {
    await session.settle(false);
    expect(session.sendMessage).not.toHaveBeenCalled();

    await session.settle(true);
    expect(session.sendMessage).toHaveBeenCalledTimes(1);
    expect(session.sendMessage.mock.calls[0]?.[0]).toMatchObject({
      customType: SESSION_MESSAGE_CUSTOM_TYPE,
      details: { messageId: "m-1" },
    });

    session.entries.push({
      type: "custom_message",
      customType: SESSION_MESSAGE_CUSTOM_TYPE,
      details: session.received,
    });
    await session.settle(true);
    expect(session.sendMessage).toHaveBeenCalledTimes(1);
  } finally {
    await session.stop();
  }
});

test("an RPC abort leaves pi's queue to deliver the message, so nothing is re-sent", async () => {
  const session = await startMessagingAfterSteeredReceipt("rpc");
  try {
    await session.settle(true);
    expect(session.sendMessage).not.toHaveBeenCalled();
  } finally {
    await session.stop();
  }
});
