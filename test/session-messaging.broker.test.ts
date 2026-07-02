import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

let cleanupDir: string | undefined;

beforeAll(() => {
  cleanupDir = mkdtempSync(join(tmpdir(), "pi-sessions-messaging-"));
  process.env.PI_SESSIONS_MESSAGING_DIR = cleanupDir;
});

afterAll(() => {
  delete process.env.PI_SESSIONS_MESSAGING_DIR;
  if (cleanupDir) {
    rmSync(cleanupDir, { recursive: true, force: true });
  }
});

test("broker lists sessions and routes messages after target acknowledgement", async () => {
  const { spawnSessionMessagingBrokerIfNeeded } = await import(
    "../extensions/session-messaging/broker/spawn.ts"
  );
  const { INCOMING_SESSION_MESSAGE_EVENT, SessionMessagingClient } = await import(
    "../extensions/session-messaging/pi/client.ts"
  );

  await spawnSessionMessagingBrokerIfNeeded();

  const source = new SessionMessagingClient();
  const target = new SessionMessagingClient();
  try {
    await source.connect({
      sessionId: "source-session",
      sessionName: "Source",
      cwd: "/tmp/source",
    });
    await target.connect({
      sessionId: "target-session",
      sessionName: "Target",
      cwd: "/tmp/target",
    });

    const incoming = new Promise<unknown>((resolve) => {
      target.once(INCOMING_SESSION_MESSAGE_EVENT, (requestId, message) => {
        target.acknowledgeIncoming(requestId, message.messageId, { delivered: true });
        resolve(message);
      });
    });

    const sessions = await source.listSessions();
    expect(sessions.map((session) => session.sessionId).sort()).toEqual([
      "source-session",
      "target-session",
    ]);

    const result = await source.sendMessage({
      messageId: "message-1",
      target: "target-session",
      body: "Investigation complete.",
      sentAt: new Date().toISOString(),
      requestResponse: true,
      sourceToolCallId: "tool-1",
    });

    expect(result.delivered).toBe(true);
    expect(result.messageId).toBe("message-1");
    await expect(incoming).resolves.toMatchObject({
      messageId: result.messageId,
      body: "Investigation complete.",
      requestResponse: true,
      sourceToolCallId: "tool-1",
      source: { sessionId: "source-session", sessionName: "Source", cwd: "/tmp/source" },
      target: { sessionId: "target-session", sessionName: "Target", cwd: "/tmp/target" },
    });
  } finally {
    source.disconnect();
    target.disconnect();
  }
});

test("broker requires exact target session ids", async () => {
  const { spawnSessionMessagingBrokerIfNeeded } = await import(
    "../extensions/session-messaging/broker/spawn.ts"
  );
  const { SessionMessagingClient } = await import("../extensions/session-messaging/pi/client.ts");

  await spawnSessionMessagingBrokerIfNeeded();

  const source = new SessionMessagingClient();
  const target = new SessionMessagingClient();
  try {
    await source.connect({ sessionId: "exact-source", cwd: "/tmp/source" });
    await target.connect({ sessionId: "exact-target", cwd: "/tmp/target" });

    const result = await source.sendMessage({
      messageId: "message-prefix-rejected",
      target: "exact",
      body: "Prefix should not route.",
      sentAt: new Date().toISOString(),
    });

    expect(result).toMatchObject({
      messageId: "message-prefix-rejected",
      delivered: false,
      error: "No live session found for id: exact",
    });
  } finally {
    source.disconnect();
    target.disconnect();
  }
});

test("broker rejects duplicate live session registrations", async () => {
  const { spawnSessionMessagingBrokerIfNeeded } = await import(
    "../extensions/session-messaging/broker/spawn.ts"
  );
  const { SessionMessagingClient } = await import("../extensions/session-messaging/pi/client.ts");

  await spawnSessionMessagingBrokerIfNeeded();

  const first = new SessionMessagingClient();
  const duplicate = new SessionMessagingClient();
  try {
    await first.connect({ sessionId: "duplicate-session", cwd: "/tmp/one" });

    await expect(
      duplicate.connect({ sessionId: "duplicate-session", cwd: "/tmp/two" }),
    ).rejects.toThrow("already registered");
  } finally {
    first.disconnect();
    duplicate.disconnect();
  }
});

test("broker fails pending sends when target disconnects before acknowledgement", async () => {
  const { spawnSessionMessagingBrokerIfNeeded } = await import(
    "../extensions/session-messaging/broker/spawn.ts"
  );
  const { INCOMING_SESSION_MESSAGE_EVENT, SessionMessagingClient } = await import(
    "../extensions/session-messaging/pi/client.ts"
  );

  await spawnSessionMessagingBrokerIfNeeded();

  const source = new SessionMessagingClient();
  const target = new SessionMessagingClient();
  try {
    await source.connect({ sessionId: "disconnect-source", cwd: "/tmp/source" });
    await target.connect({ sessionId: "disconnect-target", cwd: "/tmp/target" });

    target.once(INCOMING_SESSION_MESSAGE_EVENT, () => {
      target.disconnect();
    });

    const result = await source.sendMessage({
      messageId: "message-before-disconnect",
      target: "disconnect-target",
      body: "This will be accepted ambiguously.",
      sentAt: new Date().toISOString(),
    });

    expect(result).toMatchObject({
      messageId: "message-before-disconnect",
      delivered: false,
      error: "Target disconnected before accepting the message.",
    });
  } finally {
    source.disconnect();
    target.disconnect();
  }
});
