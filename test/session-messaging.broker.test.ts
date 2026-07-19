import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

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
  const { INCOMING_SESSION_ENVELOPE_EVENT, SessionMessagingClient } = await import(
    "../extensions/shared/session-broker/client.ts"
  );

  await spawnSessionMessagingBrokerIfNeeded();

  const source = new SessionMessagingClient();
  const target = new SessionMessagingClient();
  try {
    await source.connect("source-session");
    await target.connect("target-session");

    const incoming = new Promise<unknown>((resolve) => {
      target.once(INCOMING_SESSION_ENVELOPE_EVENT, (requestId, envelope) => {
        target.acknowledgeIncoming(requestId, { delivered: true });
        resolve(envelope);
      });
    });

    const sessionIds = await source.listSessionIds();
    expect(sessionIds.sort()).toEqual(["source-session", "target-session"]);

    const result = await source.sendEnvelope({
      target: "target-session",
      envelope: {
        kind: "message",
        messageId: "message-1",
        body: "Investigation complete.",
        sentAt: new Date().toISOString(),
        requestResponse: true,
        sourceToolCallId: "tool-1",
      },
    });

    expect(result.delivered).toBe(true);
    await expect(incoming).resolves.toMatchObject({
      kind: "message",
      messageId: "message-1",
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

test("broker routes typed subagent reports with stamped identity", async () => {
  const { spawnSessionMessagingBrokerIfNeeded } = await import(
    "../extensions/session-messaging/broker/spawn.ts"
  );
  const { SessionMessagingService } = await import("../extensions/session-messaging/pi/service.ts");
  const { SessionMessagingClient } = await import("../extensions/shared/session-broker/client.ts");

  await spawnSessionMessagingBrokerIfNeeded();
  const parent = new SessionMessagingService(join(cleanupDir ?? tmpdir(), "reports.sqlite"));
  const child = new SessionMessagingClient();
  const handler = vi.fn();
  parent.onIncomingSubagentReport(handler);
  try {
    await parent.start({ sessionManager: { getSessionId: () => "report-parent" } } as never);
    await child.connect("report-child");

    await expect(
      child.sendEnvelope({
        target: "report-parent",
        envelope: {
          kind: "subagent_report",
          reportId: "report-1",
          status: "done",
          summary: "All checks pass.",
          sentAt: "2026-03-25T00:00:00.000Z",
        },
      }),
    ).resolves.toMatchObject({ delivered: true });
    expect(handler).toHaveBeenCalledWith({
      kind: "subagent_report",
      reportId: "report-1",
      source: "report-child",
      target: "report-parent",
      status: "done",
      summary: "All checks pass.",
      sentAt: "2026-03-25T00:00:00.000Z",
    });
  } finally {
    child.disconnect();
    parent.stop();
  }
});

test("broker stamps envelope identity instead of trusting sender fields", async () => {
  const { spawnSessionMessagingBrokerIfNeeded } = await import(
    "../extensions/session-messaging/broker/spawn.ts"
  );
  const { INCOMING_SESSION_ENVELOPE_EVENT, SessionMessagingClient } = await import(
    "../extensions/shared/session-broker/client.ts"
  );

  await spawnSessionMessagingBrokerIfNeeded();

  const source = new SessionMessagingClient();
  const target = new SessionMessagingClient();
  try {
    await source.connect("actual-source");
    await target.connect("actual-target");

    const incoming = new Promise<unknown>((resolve) => {
      target.once(INCOMING_SESSION_ENVELOPE_EVENT, (requestId, envelope) => {
        target.acknowledgeIncoming(requestId, { delivered: true });
        resolve(envelope);
      });
    });

    const result = await source.sendEnvelope({
      target: "actual-target",
      envelope: {
        kind: "message",
        messageId: "forged-source-message",
        source: "forged-source",
        target: "forged-target",
        body: "Identity must come from the broker.",
        sentAt: "2026-03-24T00:00:00.000Z",
      } as never,
    });

    expect(result.delivered).toBe(true);
    await expect(incoming).resolves.toMatchObject({
      kind: "message",
      messageId: "forged-source-message",
      source: "actual-source",
      target: "actual-target",
    });
  } finally {
    source.disconnect();
    target.disconnect();
  }
});

test("service acknowledges only after the typed incoming handler accepts", async () => {
  if (!cleanupDir) {
    throw new Error("Missing messaging temp directory");
  }

  const { SessionMessagingService } = await import("../extensions/session-messaging/pi/service.ts");
  const { SessionMessagingClient } = await import("../extensions/shared/session-broker/client.ts");

  const target = new SessionMessagingService(join(cleanupDir, "acceptance.sqlite"));
  const source = new SessionMessagingClient();
  let accept: (() => void) | undefined;
  const acceptance = new Promise<void>((resolve) => {
    accept = resolve;
  });
  target.onIncomingMessage(async () => {
    await acceptance;
  });

  try {
    await target.start({ sessionManager: { getSessionId: () => "acceptance-target" } } as never);
    await source.connect("acceptance-source");

    let acknowledged = false;
    const send = source
      .sendEnvelope({
        target: "acceptance-target",
        envelope: {
          kind: "message",
          messageId: "acceptance-message",
          body: "Persist this first.",
          sentAt: "2026-03-24T00:01:00.000Z",
        },
      })
      .then((result) => {
        acknowledged = true;
        return result;
      });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(acknowledged).toBe(false);
    accept?.();
    await expect(send).resolves.toMatchObject({ delivered: true });
  } finally {
    source.disconnect();
    target.stop();
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
  const service = new SessionMessagingService(indexPath);
  service.onIncomingMessage((envelope) => {
    receivedMessages.push(service.buildReceivedMessage(envelope));
  });
  const source = new SessionMessagingClient();

  try {
    await service.start({ sessionManager: { getSessionId: () => targetId } } as never);
    await source.connect(sourceId);

    const result = await source.sendEnvelope({
      target: targetId,
      envelope: {
        kind: "message",
        messageId: "receipt-message",
        body: "Receipt enrichment check.",
        sentAt: "2026-03-22T00:31:00.000Z",
        requestResponse: true,
        sourceToolCallId: "tool-receipt",
      },
    });

    expect(result).toMatchObject({ delivered: true });
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

test("service cancels a live target and waits for broker registration", async () => {
  if (!cleanupDir) {
    throw new Error("Missing messaging temp directory");
  }

  const { SessionMessagingService } = await import("../extensions/session-messaging/pi/service.ts");
  const { SessionMessagingClient } = await import("../extensions/shared/session-broker/client.ts");

  const source = new SessionMessagingService(join(cleanupDir, "cancel.sqlite"));
  const target = new SessionMessagingService(join(cleanupDir, "cancel.sqlite"));
  const late = new SessionMessagingClient();
  const cancellations: unknown[] = [];
  target.onIncomingCancel((envelope) => {
    cancellations.push(envelope);
  });

  try {
    await source.start({ sessionManager: { getSessionId: () => "cancel-source" } } as never);
    await target.start({ sessionManager: { getSessionId: () => "cancel-target" } } as never);

    const result = await source.cancelSession("cancel-target");
    expect(result).toMatchObject({
      delivered: true,
      cancelId: expect.any(String),
      target: { sessionId: "cancel-target" },
    });
    expect(cancellations).toEqual([
      expect.objectContaining({
        kind: "cancel",
        cancelId: result.cancelId,
        source: "cancel-source",
        target: "cancel-target",
      }),
    ]);

    const wait = source.waitForSession("late-registration", 1_000);
    await late.connect("late-registration");
    await expect(wait).resolves.toBe(true);
    await expect(source.waitForSession("missing-registration", 0)).resolves.toBe(false);
  } finally {
    late.disconnect();
    target.stop();
    source.stop();
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

    const result = await source.sendEnvelope({
      target: "exact",
      envelope: {
        kind: "message",
        messageId: "message-prefix-rejected",
        body: "Prefix should not route.",
        sentAt: new Date().toISOString(),
      },
    });

    expect(result).toMatchObject({
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
  const { INCOMING_SESSION_ENVELOPE_EVENT, SessionMessagingClient } = await import(
    "../extensions/shared/session-broker/client.ts"
  );

  await spawnSessionMessagingBrokerIfNeeded();

  const source = new SessionMessagingClient();
  const target = new SessionMessagingClient();
  try {
    await source.connect("disconnect-source");
    await target.connect("disconnect-target");

    target.once(INCOMING_SESSION_ENVELOPE_EVENT, () => {
      target.disconnect();
    });

    const result = await source.sendEnvelope({
      target: "disconnect-target",
      envelope: {
        kind: "message",
        messageId: "message-before-disconnect",
        body: "This will be accepted ambiguously.",
        sentAt: new Date().toISOString(),
      },
    });

    expect(result).toMatchObject({
      delivered: false,
      error: "Target disconnected before accepting the envelope.",
    });
  } finally {
    source.disconnect();
    target.disconnect();
  }
});
