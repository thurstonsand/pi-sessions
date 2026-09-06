import { expect, test, vi } from "vitest";
import { buildHandoffKickoffMessage } from "../extensions/session-handoff/kickoff.ts";
import {
  createChildGeneratedHandoffBootstrap,
  HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
  SESSION_STARTING_MESSAGE,
} from "../extensions/session-handoff/metadata.ts";
import { IncomingSessionMessageRuntime } from "../extensions/session-messaging/pi/incoming-runtime.ts";
import { createSessionCancelTool } from "../extensions/session-messaging/pi/tools.ts";

function pendingBootstrapEntry() {
  return {
    type: "custom",
    id: "bootstrap-1",
    customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
    data: createChildGeneratedHandoffBootstrap({
      sessionId: "child-1",
      goal: "Finish phase 1",
      title: "Implement autocomplete",
      parentSessionFile: "/tmp/parent.jsonl",
      sourceLeafId: "source-leaf",
      requestResponse: false,
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
  const runtime = new IncomingSessionMessageRuntime({ appendEntry, sendMessage } as never);
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
  const runtime = new IncomingSessionMessageRuntime({ appendEntry, sendMessage } as never);
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
    sessionManager: { getBranch: () => [pendingBootstrapEntry(), kickoff] },
  } as never);

  runtime.deliver(receivedMessage());
  expect(appendEntry).toHaveBeenCalledOnce();
  expect(sendMessage).toHaveBeenCalledOnce();
});

test("incoming cancellation aborts the target runtime before acceptance", () => {
  const abort = vi.fn();
  const runtime = new IncomingSessionMessageRuntime({
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as never);
  runtime.bindContext({ abort } as never);

  runtime.cancel();
  expect(abort).toHaveBeenCalledOnce();
});

test("session_cancel reports accepted live cancellation", async () => {
  const cancelSession = vi.fn(async () => ({
    kind: "transport" as const,
    delivered: true as const,
    cancelId: "cancel-1",
    target: { sessionId: "target-session", sessionName: "Target" },
    relation: "sibling" as const,
  }));
  const tool = createSessionCancelTool({ cancelSession } as never, { role: { kind: "plain" } });

  const result = await tool.execute(
    "tool-1",
    { session: "target-session" },
    undefined,
    undefined,
    {} as never,
  );

  expect(cancelSession).toHaveBeenCalledWith("target-session");
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

test("session_cancel reports managed teardown honestly", async () => {
  const tool = createSessionCancelTool(
    {
      cancelSession: vi.fn(async () => ({
        kind: "managed" as const,
        accepted: true as const,
        target: { sessionId: "child-session", sessionName: "Child" },
        state: "stopping",
      })),
    },
    { role: { kind: "plain" } },
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

test("session_cancel rejects an unknown managed state", async () => {
  const tool = createSessionCancelTool(
    {
      cancelSession: vi.fn(async () => ({
        kind: "managed" as const,
        accepted: true as const,
        target: { sessionId: "child-session", sessionName: "Child" },
        state: "unknown",
      })),
    },
    { role: { kind: "plain" } },
  );

  await expect(
    tool.execute("tool-3", { session: "child-session" }, undefined, undefined, {} as never),
  ).rejects.toThrow('Could not confirm cancellation of subagent "Child".\nsession child-session');
});

test("session_cancel rejects dead targets", async () => {
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
    { role: { kind: "plain" } },
  );

  await expect(
    tool.execute("tool-4", { session: "dead-session" }, undefined, undefined, {} as never),
  ).rejects.toThrow(
    "No running session found: dead-session.\nThe target is not an owned subagent and has no broker-live process to cancel.",
  );
});

test("incoming cancellation is rejected until the target runtime is bound", () => {
  const runtime = new IncomingSessionMessageRuntime({
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as never);

  expect(() => runtime.cancel()).toThrow("Target session is not ready.");
});
