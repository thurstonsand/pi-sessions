import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatError } from "../../shared/errors.ts";
import {
  INCOMING_SESSION_ENVELOPE_EVENT,
  type SessionEnvelopeSendResult,
  SessionMessagingClient,
} from "../../shared/session-broker/client.ts";
import type {
  OutboundSessionEnvelope,
  SessionCancelEnvelope,
  SessionEnvelope,
  SessionEnvelopeSendFailureReason,
  SessionMessageEnvelope,
  SessionSubagentReportEnvelope,
  TaskReport,
} from "../../shared/session-broker/protocol.ts";
import type {
  SessionLineageRelation,
  SessionLineageRow,
} from "../../shared/session-index/index.ts";
import {
  getLineageRelationMap,
  getSessionById,
  withSessionIndex,
} from "../../shared/session-index/index.ts";
import { spawnSessionMessagingBrokerIfNeeded } from "../broker/spawn.ts";
import type { ReceivedMessageEndpoint, ReceivedMessageEntry } from "./message-contracts.ts";

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
const SESSION_WAIT_POLL_MS = 100;

export interface SendMessageRequest {
  target: string;
  body: string;
  requestResponse?: boolean | undefined;
  sourceToolCallId?: string | undefined;
}

export type SendMessageResult =
  | {
      messageId: string;
      delivered: false;
      reason?: SessionEnvelopeSendFailureReason | undefined;
      error?: string | undefined;
    }
  | {
      messageId: string;
      delivered: true;
      target: ReceivedMessageEndpoint;
      relation?: SessionLineageRelation | undefined;
    };

export type CancelSessionResult =
  | {
      cancelId: string;
      delivered: false;
      error?: string | undefined;
    }
  | {
      cancelId: string;
      delivered: true;
      target: ReceivedMessageEndpoint;
      relation?: SessionLineageRelation | undefined;
    };

export type IncomingMessageHandler = (envelope: SessionMessageEnvelope) => Promise<void> | void;
export type IncomingCancelHandler = (envelope: SessionCancelEnvelope) => Promise<void> | void;
export type IncomingSubagentReportHandler = (
  envelope: SessionSubagentReportEnvelope,
) => Promise<void> | void;

export type SendSubagentReportResult = SessionEnvelopeSendResult;

export interface SendSubagentReportRequest extends TaskReport {
  target: string;
  reportId: string;
}

interface IncomingMessageIndexContext {
  source: ReceivedMessageEndpoint;
  target: ReceivedMessageEndpoint;
  relation?: SessionLineageRelation | undefined;
}

export class SessionMessagingService {
  private readonly indexPath: string;
  private relationBySessionId = new Map<string, SessionLineageRelation | undefined>();
  private incomingMessageHandler: IncomingMessageHandler | undefined;
  private incomingCancelHandler: IncomingCancelHandler | undefined;
  private incomingSubagentReportHandler: IncomingSubagentReportHandler | undefined;
  private readonly connection = new BrokerConnection((envelope) => this.acceptIncoming(envelope));

  constructor(indexPath: string) {
    this.indexPath = indexPath;
  }

  async start(ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    this.refreshCachedRelations(sessionId);
    await this.connection.start(sessionId);
  }

  stop(): void {
    this.relationBySessionId.clear();
    this.connection.stop();
  }

  onIncomingMessage(handler: IncomingMessageHandler): void {
    if (this.incomingMessageHandler) {
      throw new Error("An incoming message handler is already registered.");
    }
    this.incomingMessageHandler = handler;
  }

  onIncomingCancel(handler: IncomingCancelHandler): void {
    if (this.incomingCancelHandler) {
      throw new Error("An incoming cancel handler is already registered.");
    }
    this.incomingCancelHandler = handler;
  }

  onIncomingSubagentReport(handler: IncomingSubagentReportHandler): void {
    if (this.incomingSubagentReportHandler) {
      throw new Error("An incoming subagent report handler is already registered.");
    }
    this.incomingSubagentReportHandler = handler;
  }

  async listSessions(): Promise<string[]> {
    return this.connection.listSessionIds();
  }

  async waitForSession(sessionId: string, timeoutMs: number): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error("Session wait timeout must be a non-negative finite number.");
    }

    const deadline = Date.now() + timeoutMs;
    while (true) {
      if ((await this.listSessions()).includes(sessionId)) {
        return true;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return false;
      }
      await delay(Math.min(SESSION_WAIT_POLL_MS, remainingMs));
    }
  }

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    const relation = this.getCachedRelationTo(request.target, true);
    const messageId = randomUUID();
    const result = await this.connection.sendEnvelope({
      target: request.target,
      envelope: {
        kind: "message",
        messageId,
        body: request.body,
        ...(request.requestResponse === undefined
          ? {}
          : { requestResponse: request.requestResponse }),
        ...(request.sourceToolCallId === undefined
          ? {}
          : { sourceToolCallId: request.sourceToolCallId }),
        sentAt: new Date().toISOString(),
      },
    });

    if (!result.delivered) {
      return {
        messageId,
        delivered: false,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    }

    return {
      messageId,
      delivered: true,
      target: this.getTargetEndpoint(request.target),
      ...(relation === undefined ? {} : { relation }),
    };
  }

  async sendSubagentReport(request: SendSubagentReportRequest): Promise<SendSubagentReportResult> {
    return this.connection.sendEnvelope({
      target: request.target,
      envelope: {
        kind: "subagent_report",
        reportId: request.reportId,
        status: request.status,
        summary: request.summary,
        ...(request.details ? { details: request.details } : {}),
        ...(request.references ? { references: request.references } : {}),
        ...(request.nextSteps ? { nextSteps: request.nextSteps } : {}),
        sentAt: new Date().toISOString(),
      },
    });
  }

  async cancelSession(sessionId: string): Promise<CancelSessionResult> {
    const relation = this.getCachedRelationTo(sessionId, true);
    const cancelId = randomUUID();
    const result = await this.connection.sendEnvelope({
      target: sessionId,
      envelope: {
        kind: "cancel",
        cancelId,
        sentAt: new Date().toISOString(),
      },
    });

    if (!result.delivered) {
      return {
        cancelId,
        delivered: false,
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    }

    return {
      cancelId,
      delivered: true,
      target: this.getTargetEndpoint(sessionId),
      ...(relation === undefined ? {} : { relation }),
    };
  }

  buildReceivedMessage(message: SessionMessageEnvelope): ReceivedMessageEntry {
    const context = this.getIncomingMessageIndexContext(message.source, message.target);
    return {
      messageId: message.messageId,
      source: context.source,
      target: context.target,
      body: message.body,
      sentAt: message.sentAt,
      receivedAt: new Date().toISOString(),
      ...(message.requestResponse === undefined
        ? {}
        : { requestResponse: message.requestResponse }),
      ...(message.sourceToolCallId === undefined
        ? {}
        : { sourceToolCallId: message.sourceToolCallId }),
      ...(context.relation === undefined ? {} : { relation: context.relation }),
    };
  }

  getCachedRelationTo(
    sessionId: string | undefined,
    refresh = false,
  ): SessionLineageRelation | undefined {
    if (!sessionId) {
      return undefined;
    }

    if (this.relationBySessionId.has(sessionId)) {
      return this.relationBySessionId.get(sessionId);
    }

    if (!refresh) {
      return undefined;
    }

    const identity = this.connection.currentSessionId;
    if (!identity) {
      throw new Error("Session messaging is not active.");
    }

    this.refreshCachedRelations(identity);
    if (!this.relationBySessionId.has(sessionId)) {
      this.relationBySessionId.set(sessionId, undefined);
    }

    return this.relationBySessionId.get(sessionId);
  }

  private async acceptIncoming(envelope: SessionEnvelope): Promise<IncomingAcceptance> {
    try {
      switch (envelope.kind) {
        case "message": {
          if (!this.incomingMessageHandler) {
            throw new Error("Target session has no incoming message handler.");
          }
          await this.incomingMessageHandler(envelope);
          break;
        }
        case "cancel": {
          if (!this.incomingCancelHandler) {
            throw new Error("Target session has no incoming cancel handler.");
          }
          await this.incomingCancelHandler(envelope);
          break;
        }
        case "subagent_report": {
          if (!this.incomingSubagentReportHandler) {
            throw new Error("Target session has no incoming subagent report handler.");
          }
          await this.incomingSubagentReportHandler(envelope);
          break;
        }
      }
      return { delivered: true };
    } catch (error) {
      return {
        delivered: false,
        error: formatError(error),
      };
    }
  }

  private getTargetEndpoint(targetSessionId: string): ReceivedMessageEndpoint {
    return (
      withSessionIndex(this.indexPath, { mode: "read", required: false }, ({ db }) =>
        buildReceivedMessageEndpoint(targetSessionId, getSessionById(db, targetSessionId)),
      ) ?? buildReceivedMessageEndpoint(targetSessionId)
    );
  }

  private getIncomingMessageIndexContext(
    sourceSessionId: string,
    targetSessionId: string,
  ): IncomingMessageIndexContext {
    const fallback = {
      source: buildReceivedMessageEndpoint(sourceSessionId),
      target: buildReceivedMessageEndpoint(targetSessionId),
    };
    return (
      withSessionIndex(this.indexPath, { mode: "read", required: false }, ({ db }) => {
        const source = getSessionById(db, sourceSessionId);
        const target = getSessionById(db, targetSessionId);
        const currentSessionId = this.connection.currentSessionId;
        const relationBySessionId = currentSessionId
          ? new Map(getLineageRelationMap(db, currentSessionId))
          : new Map<string, SessionLineageRelation>();
        const relation = relationBySessionId.get(sourceSessionId);

        if (currentSessionId) {
          this.replaceCachedRelations(relationBySessionId);
          if (!this.relationBySessionId.has(sourceSessionId)) {
            this.relationBySessionId.set(sourceSessionId, undefined);
          }
        }

        return {
          source: buildReceivedMessageEndpoint(sourceSessionId, source),
          target: buildReceivedMessageEndpoint(targetSessionId, target),
          ...(relation === undefined ? {} : { relation }),
        };
      }) ?? fallback
    );
  }

  private refreshCachedRelations(currentSessionId: string): void {
    this.replaceCachedRelations(getRelationMapForSession(this.indexPath, currentSessionId));
  }

  private replaceCachedRelations(
    nextRelations: Map<string, SessionLineageRelation | undefined>,
  ): void {
    const previousRelations = this.relationBySessionId;

    for (const [sessionId, relation] of previousRelations) {
      if (relation === undefined && !nextRelations.has(sessionId)) {
        nextRelations.set(sessionId, undefined);
      }
    }

    this.relationBySessionId = nextRelations;
  }
}

type IncomingAcceptance = { delivered: true } | { delivered: false; error: string };

class BrokerConnection {
  private client: SessionMessagingClient | undefined;
  private sessionId: string | undefined;
  private active = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelayIndex = 0;
  private connectPromise: Promise<void> | undefined;

  constructor(
    private readonly onIncoming: (envelope: SessionEnvelope) => Promise<IncomingAcceptance>,
  ) {}

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  async start(sessionId: string): Promise<void> {
    this.active = true;
    this.sessionId = sessionId;
    await this.ensureConnectedNow();
  }

  stop(): void {
    this.active = false;
    this.sessionId = undefined;
    this.clearReconnectTimer();
    this.client?.disconnect();
    this.client = undefined;
    this.connectPromise = undefined;
  }

  async listSessionIds(): Promise<string[]> {
    await this.ensureConnectedNow();
    return this.requireClient().listSessionIds();
  }

  async sendEnvelope(options: {
    target: string;
    envelope: OutboundSessionEnvelope;
  }): Promise<SessionEnvelopeSendResult> {
    await this.ensureConnectedNow();
    return this.requireClient().sendEnvelope(options);
  }

  private async acceptIncoming(
    client: SessionMessagingClient,
    requestId: string,
    envelope: SessionEnvelope,
  ): Promise<void> {
    const result = await this.onIncoming(envelope);
    if (this.client !== client || !client.isConnected) {
      return;
    }

    try {
      client.acknowledgeIncoming(requestId, result);
    } catch {}
  }

  private async ensureConnectedNow(): Promise<void> {
    if (this.client?.isConnected) {
      return;
    }
    if (!this.active || !this.sessionId) {
      throw new Error("Session messaging is not active.");
    }
    this.clearReconnectTimer();

    if (!this.connectPromise) {
      this.connectPromise = this.connect().finally(() => {
        this.connectPromise = undefined;
      });
    }

    try {
      await this.connectPromise;
    } catch (error) {
      this.scheduleReconnect();
      throw error;
    }
  }

  private async connect(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) {
      throw new Error("Session messaging is not active.");
    }

    this.client?.disconnect();
    this.client = undefined;

    await spawnSessionMessagingBrokerIfNeeded();
    const client = new SessionMessagingClient();
    client.on(INCOMING_SESSION_ENVELOPE_EVENT, (requestId: string, envelope: SessionEnvelope) => {
      void this.acceptIncoming(client, requestId, envelope);
    });
    client.on("disconnect", () => {
      if (this.client === client) {
        this.client = undefined;
        this.scheduleReconnect();
      }
    });

    await client.connect(sessionId);
    this.client = client;
    this.reconnectDelayIndex = 0;
  }

  private scheduleReconnect(): void {
    if (!this.active || this.reconnectTimer) {
      return;
    }

    const delayMs = RECONNECT_DELAYS_MS[this.reconnectDelayIndex] ?? 30_000;
    this.reconnectDelayIndex = Math.min(
      this.reconnectDelayIndex + 1,
      RECONNECT_DELAYS_MS.length - 1,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.ensureConnectedNow().catch(() => {});
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private requireClient(): SessionMessagingClient {
    if (!this.client?.isConnected) {
      throw new Error("Session messaging is not connected.");
    }
    return this.client;
  }
}

function buildReceivedMessageEndpoint(
  sessionId: string,
  session?: SessionLineageRow | undefined,
): ReceivedMessageEndpoint {
  const sessionName = session?.sessionName.trim();
  return {
    sessionId,
    ...(sessionName ? { sessionName } : {}),
    ...(session?.cwd ? { cwd: session.cwd } : {}),
  };
}

function getRelationMapForSession(
  indexPath: string,
  sessionId: string,
): Map<string, SessionLineageRelation | undefined> {
  return (
    withSessionIndex(
      indexPath,
      { mode: "read", required: false },
      ({ db }) => new Map(getLineageRelationMap(db, sessionId)),
    ) ?? new Map()
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
