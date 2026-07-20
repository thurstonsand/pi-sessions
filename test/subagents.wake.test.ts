import { describe, expect, it, vi } from "vitest";
import type { SendMessageResult } from "../extensions/session-messaging/install.ts";
import { SUBAGENT_LAUNCHED_CUSTOM_TYPE } from "../extensions/subagents/ledger.ts";
import { SubagentMessageRouter } from "../extensions/subagents/wake.ts";

const parentId = "12345678-1234-1234-1234-123456789abc";
const childId = "87654321-1234-1234-1234-123456789abc";

const request = {
  target: childId,
  body: "Provide more detail.",
  requestResponse: true,
  sourceToolCallId: "tool-1",
};

describe("subagent wake-on-send", () => {
  it("sends directly when the target is already broker-live", async () => {
    const tmux = createTmux(false);
    const messaging = createMessaging({ live: [childId] });
    const router = createRouter(tmux, messaging);

    await expect(router.sendMessage(request)).resolves.toMatchObject({ delivered: true });

    expect(messaging.sendMessage).toHaveBeenCalledWith(request);
    expect(tmux.exec).not.toHaveBeenCalled();
  });

  it("retries through wake when a live child disconnects before accepting the message", async () => {
    const tmux = createTmux(false);
    const messaging = createMessaging({ waits: [true] });
    messaging.listSessions
      .mockResolvedValueOnce([childId])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
    messaging.sendMessage
      .mockResolvedValueOnce({
        delivered: false,
        messageId: "message-1",
        reason: "disconnected",
        error: "Target disconnected before accepting the envelope.",
      })
      .mockResolvedValueOnce({
        delivered: true,
        messageId: "message-2",
        target: { sessionId: childId },
      });
    const router = createRouter(tmux, messaging);

    await expect(router.sendMessage(request)).resolves.toMatchObject({
      delivered: true,
      messageId: "message-2",
    });

    expect(tmux.created()).toBe(1);
    expect(messaging.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("materializes a dormant owned child and reconciles after sending", async () => {
    const tmux = createTmux(false);
    const messaging = createMessaging({ waits: [true] });
    const afterOwnedSend = vi.fn();
    const router = createRouter(tmux, messaging, afterOwnedSend);

    await expect(router.sendMessage(request)).resolves.toMatchObject({ delivered: true });

    expect(tmux.created()).toBe(1);
    expect(messaging.waitForSession).toHaveBeenCalledWith(childId, 25);
    expect(messaging.sendMessage).toHaveBeenCalledWith(request);
    expect(afterOwnedSend).toHaveBeenCalledOnce();
  });

  it("replaces a window that never registered, then delivers the message", async () => {
    const tmux = createTmux(true);
    const messaging = createMessaging({ waits: [false, true] });
    const router = createRouter(tmux, messaging);

    await expect(router.sendMessage(request)).resolves.toMatchObject({ delivered: true });

    expect(tmux.killed()).toBe(1);
    expect(tmux.created()).toBe(1);
    expect(messaging.waitForSession).toHaveBeenCalledTimes(2);
  });

  it("does not spawn a duplicate when a stale window cannot be killed", async () => {
    const tmux = createTmux(true, false);
    const messaging = createMessaging({ waits: [false] });
    const router = createRouter(tmux, messaging);

    await expect(router.sendMessage(request)).rejects.toThrow("could not be stopped");

    expect(tmux.created()).toBe(0);
    expect(messaging.sendMessage).not.toHaveBeenCalled();
  });

  it("shares one materialization across concurrent messages", async () => {
    const tmux = createTmux(false);
    let releaseReady: ((ready: boolean) => void) | undefined;
    const messaging = createMessaging();
    messaging.waitForSession.mockImplementation(
      () => new Promise<boolean>((resolve) => (releaseReady = resolve)),
    );
    const router = createRouter(tmux, messaging);

    const first = router.sendMessage(request);
    const second = router.sendMessage({ ...request, body: "One more question." });
    await vi.waitFor(() => expect(releaseReady).toBeDefined());
    releaseReady?.(true);
    await Promise.all([first, second]);

    expect(tmux.created()).toBe(1);
    expect(messaging.waitForSession).toHaveBeenCalledOnce();
    expect(messaging.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("leaves an unregistered replacement visible for later recovery", async () => {
    const tmux = createTmux(false);
    const messaging = createMessaging({ waits: [false, false] });
    const router = createRouter(tmux, messaging);

    await expect(router.sendMessage(request)).rejects.toThrow("did not register for messaging");

    expect(tmux.created()).toBe(2);
    expect(tmux.exists()).toBe(true);
    expect(messaging.sendMessage).not.toHaveBeenCalled();
  });
});

function createRouter(
  tmux: ReturnType<typeof createTmux>,
  messaging: ReturnType<typeof createMessaging>,
  afterOwnedSend?: () => void,
) {
  const parent = {
    sessionId: parentId,
    epoch: 4,
    getBranch: () => [launchEntry()],
  };
  return new SubagentMessageRouter(
    tmux as never,
    messaging,
    () => parent as never,
    (epoch) => epoch === 4,
    { readyTimeoutMs: 25, ...(afterOwnedSend ? { afterOwnedSend } : {}) },
  );
}

function createMessaging(options: { live?: string[]; waits?: boolean[] } = {}) {
  const waits = [...(options.waits ?? [])];
  return {
    listSessions: vi.fn(async () => options.live ?? []),
    waitForSession: vi.fn(async () => waits.shift() ?? false),
    sendMessage: vi.fn(
      async (): Promise<SendMessageResult> => ({
        delivered: true,
        messageId: "message-1",
        target: { sessionId: childId },
      }),
    ),
  };
}

function createTmux(initialWindow: boolean, killSucceeds = true) {
  let windowExists = initialWindow;
  let created = 0;
  let killed = 0;
  const exec = vi.fn(async (_command: string, args: string[]) => {
    switch (args[0]) {
      case "list-windows":
        if (!windowExists) {
          return { code: 1, stdout: "", stderr: "can't find session" };
        }
        return { code: 0, stdout: `@1\tChild\t${childId}\n`, stderr: "" };
      case "has-session":
        return { code: windowExists ? 0 : 1, stdout: "", stderr: "" };
      case "new-session":
      case "new-window":
        windowExists = true;
        created += 1;
        return { code: 0, stdout: "@1\n", stderr: "" };
      case "set-option":
        return { code: 0, stdout: "", stderr: "" };
      case "kill-window":
        killed += 1;
        if (killSucceeds) {
          windowExists = false;
        }
        return { code: killSucceeds ? 0 : 1, stdout: "", stderr: "kill failed" };
      default:
        throw new Error(`Unexpected tmux command: ${args.join(" ")}`);
    }
  });
  return {
    exec,
    created: () => created,
    killed: () => killed,
    exists: () => windowExists,
  };
}

function launchEntry() {
  return {
    type: "custom" as const,
    id: "launch",
    parentId: null,
    timestamp: "2026-03-25T00:00:00.000Z",
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
      resumeCommand: "pi --resume child",
      depth: 1,
    },
  };
}
