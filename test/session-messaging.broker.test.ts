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

test("broker lists session ids and routes messages after target acknowledgement", async () => {
  const { spawnSessionMessagingBrokerIfNeeded } = await import(
    "../extensions/session-messaging/broker/spawn.ts"
  );
  const { INCOMING_SESSION_MESSAGE_EVENT, SessionMessagingClient } = await import(
    "../extensions/shared/session-broker/client.ts"
  );

  await spawnSessionMessagingBrokerIfNeeded();

  const source = new SessionMessagingClient();
  const target = new SessionMessagingClient();
  try {
    await source.connect("source-session");
    await target.connect("target-session");

    const incoming = new Promise<unknown>((resolve) => {
      target.once(INCOMING_SESSION_MESSAGE_EVENT, (requestId, message) => {
        target.acknowledgeIncoming(requestId, message.messageId, { delivered: true });
        resolve(message);
      });
    });

    const sessionIds = await source.listSessionIds();
    expect(sessionIds.sort()).toEqual(["source-session", "target-session"]);

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
      source: "source-session",
      target: "target-session",
    });
  } finally {
    source.disconnect();
    target.disconnect();
  }
});

test("service enriches incoming receipts from the session index", async () => {
  if (!cleanupDir) {
    throw new Error("Missing messaging temp directory");
  }

  const { SessionMessagingService } = await import("../extensions/session-messaging/pi/service.ts");
  const { SessionMessagingClient } = await import("../extensions/shared/session-broker/client.ts");
  const { initializeSchema, insertSession, openIndexDatabase, rebuildSessionLineageRelations } =
    await import("../extensions/shared/session-index/index.ts");

  const indexPath = join(cleanupDir, "receipt-enrichment.sqlite");
  const sourceId = "receipt-source-session";
  const targetId = "receipt-target-session";
  const db = openIndexDatabase(indexPath, { create: true });
  initializeSchema(db);
  insertSession(
    db,
    {
      sessionId: sourceId,
      sessionPath: "/tmp/receipt-source.jsonl",
      sessionName: "Receipt Source",
      cwd: "/repo/source",
      repoRoots: ["/repo"],
      startedAt: "2026-03-22T00:00:00.000Z",
      modifiedAt: "2026-03-22T00:10:00.000Z",
      messageCount: 2,
      entryCount: 2,
    },
    "full_reindex",
  );
  insertSession(
    db,
    {
      sessionId: targetId,
      sessionPath: "/tmp/receipt-target.jsonl",
      sessionName: "Receipt Target",
      cwd: "/repo/target",
      repoRoots: ["/repo"],
      startedAt: "2026-03-22T00:20:00.000Z",
      modifiedAt: "2026-03-22T00:30:00.000Z",
      messageCount: 3,
      entryCount: 3,
      parentSessionPath: "/tmp/receipt-source.jsonl",
      parentSessionId: sourceId,
      sessionOrigin: "handoff",
    },
    "full_reindex",
  );
  rebuildSessionLineageRelations(db);
  db.close();

  const receivedMessages: unknown[] = [];
  const service = new SessionMessagingService(indexPath, {
    deliver(received: unknown) {
      receivedMessages.push(received);
      return { delivered: true as const };
    },
  } as never);
  const source = new SessionMessagingClient();

  try {
    await service.start({ sessionManager: { getSessionId: () => targetId } } as never);
    await source.connect(sourceId);

    const result = await source.sendMessage({
      messageId: "receipt-message",
      target: targetId,
      body: "Receipt enrichment check.",
      sentAt: "2026-03-22T00:31:00.000Z",
      requestResponse: true,
      sourceToolCallId: "tool-receipt",
    });

    expect(result).toMatchObject({ delivered: true, messageId: "receipt-message" });
    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0]).toMatchObject({
      messageId: "receipt-message",
      source: {
        sessionId: sourceId,
        sessionName: "Receipt Source",
        cwd: "/repo/source",
      },
      target: {
        sessionId: targetId,
        sessionName: "Receipt Target",
        cwd: "/repo/target",
      },
      body: "Receipt enrichment check.",
      sentAt: "2026-03-22T00:31:00.000Z",
      requestResponse: true,
      sourceToolCallId: "tool-receipt",
      relation: "parent",
      receivedAt: expect.any(String),
    });
  } finally {
    source.disconnect();
    service.stop();
  }
});

test("broker requires exact target session ids", async () => {
  const { spawnSessionMessagingBrokerIfNeeded } = await import(
    "../extensions/session-messaging/broker/spawn.ts"
  );
  const { SessionMessagingClient } = await import("../extensions/shared/session-broker/client.ts");

  await spawnSessionMessagingBrokerIfNeeded();

  const source = new SessionMessagingClient();
  const target = new SessionMessagingClient();
  try {
    await source.connect("exact-source");
    await target.connect("exact-target");

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
  const { SessionMessagingClient } = await import("../extensions/shared/session-broker/client.ts");

  await spawnSessionMessagingBrokerIfNeeded();

  const first = new SessionMessagingClient();
  const duplicate = new SessionMessagingClient();
  try {
    await first.connect("duplicate-session");

    await expect(duplicate.connect("duplicate-session")).rejects.toThrow("already registered");
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
    "../extensions/shared/session-broker/client.ts"
  );

  await spawnSessionMessagingBrokerIfNeeded();

  const source = new SessionMessagingClient();
  const target = new SessionMessagingClient();
  try {
    await source.connect("disconnect-source");
    await target.connect("disconnect-target");

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
