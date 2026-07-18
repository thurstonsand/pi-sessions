import { expect, test, vi } from "vitest";
import { IncomingSessionMessageRuntime } from "../extensions/session-messaging/pi/incoming-runtime.ts";
import { createSessionCancelTool } from "../extensions/session-messaging/pi/tools.ts";

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
    delivered: true as const,
    cancelId: "cancel-1",
    target: { sessionId: "target-session", sessionName: "Target" },
    relation: "sibling" as const,
  }));
  const tool = createSessionCancelTool({ cancelSession } as never);

  const result = await tool.execute(
    "tool-1",
    { session: "target-session" },
    undefined,
    undefined,
    {} as never,
  );

  expect(cancelSession).toHaveBeenCalledWith("target-session");
  expect(result).toMatchObject({
    content: [{ type: "text", text: "Cancellation delivered to target-session." }],
    details: {
      delivered: true,
      cancelId: "cancel-1",
      target: { sessionId: "target-session", sessionName: "Target" },
      relation: "sibling",
    },
  });
});

test("session_cancel rejects dead targets", async () => {
  const tool = createSessionCancelTool({
    cancelSession: vi.fn(async () => ({
      delivered: false as const,
      cancelId: "cancel-2",
      error: "No live session found for id: dead-session",
    })),
  } as never);

  await expect(
    tool.execute("tool-2", { session: "dead-session" }, undefined, undefined, {} as never),
  ).rejects.toThrow("No live session found for id: dead-session");
});

test("incoming cancellation is rejected until the target runtime is bound", () => {
  const runtime = new IncomingSessionMessageRuntime({
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as never);

  expect(() => runtime.cancel()).toThrow("Target session is not ready.");
});
