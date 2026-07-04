import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type ActiveSessionBrokerConnection,
  setActiveSessionBrokerConnection,
} from "../../shared/session-broker/active.ts";
import {
  INCOMING_SESSION_MESSAGE_EVENT,
  type SessionMessageSendResult,
  SessionMessagingClient,
} from "../../shared/session-broker/client.ts";
import type { SessionMessagePayload } from "../../shared/session-broker/protocol.ts";
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
import type { IncomingSessionMessageRuntime } from "./incoming-runtime.ts";
import type { ReceivedMessageEndpoint, ReceivedMessageEntry } from "./message-contracts.ts";

export const MESSAGE_SENT_CUSTOM_TYPE = "pi-sessions.message_sent";

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;

export interface SendMessageRequest {
  target: string;
  body: string;
  requestResponse?: boolean | undefined;
  sourceToolCallId?: string | undefined;
}

interface IncomingMessageIndexContext {
  source: ReceivedMessageEndpoint;
  target: ReceivedMessageEndpoint;
  relation?: SessionLineageRelation | undefined;
}

export class SessionMessagingService {
  private readonly indexPath: string;
  private readonly incomingRuntime: IncomingSessionMessageRuntime;
  private readonly appendEntry: (customType: string, data: unknown) => void;
  private relationBySessionId = new Map<string, SessionLineageRelation | undefined>();
  private readonly connection = new BrokerConnection((requestId, message) =>
    this.handleIncoming(requestId, message),
  );

  constructor(
    indexPath: string,
    incomingRuntime: IncomingSessionMessageRuntime,
    appendEntry: (customType: string, data: unknown) => void,
  ) {
    this.indexPath = indexPath;
    this.incomingRuntime = incomingRuntime;
    this.appendEntry = appendEntry;
  }

  async start(ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    this.refreshCachedRelations(sessionId);
    setActiveSessionBrokerConnection(this.connection);
    await this.connection.start(sessionId);
  }

  stop(): void {
    setActiveSessionBrokerConnection(undefined);
    this.relationBySessionId.clear();
    this.connection.stop();
  }

  async sendMessage(request: SendMessageRequest): Promise<SessionMessageSendResult> {
    const relation = this.getCachedRelationTo(request.target, true);
    const sentAt = new Date().toISOString();
    const messageId = randomUUID();
    const result = await this.connection.sendMessage({
      messageId,
      target: request.target,
      body: request.body,
      sentAt,
      requestResponse: request.requestResponse,
      sourceToolCallId: request.sourceToolCallId,
    });

    if (result.delivered) {
      this.appendEntry(MESSAGE_SENT_CUSTOM_TYPE, {
        messageId: result.messageId,
        target: request.target,
        body: request.body,
        requestResponse: request.requestResponse,
        sourceToolCallId: request.sourceToolCallId,
        sentAt,
        ...(relation === undefined ? {} : { relation }),
      });
    }

    return result;
  }

  private handleIncoming(requestId: string, message: SessionMessagePayload): void {
    const received = this.buildReceivedMessageEntry(message);
    const result = this.incomingRuntime.deliver(received);
    this.connection.acknowledgeIncoming(requestId, message.messageId, result);
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

  private buildReceivedMessageEntry(message: SessionMessagePayload): ReceivedMessageEntry {
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

class BrokerConnection implements ActiveSessionBrokerConnection {
  private client: SessionMessagingClient | undefined;
  private sessionId: string | undefined;
  private active = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelayIndex = 0;
  private connectPromise: Promise<void> | undefined;

  constructor(
    private readonly onIncoming: (requestId: string, message: SessionMessagePayload) => void,
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

  async sendMessage(options: {
    messageId: string;
    target: string;
    body: string;
    sentAt: string;
    requestResponse?: boolean | undefined;
    sourceToolCallId?: string | undefined;
  }): Promise<SessionMessageSendResult> {
    await this.ensureConnectedNow();
    return this.requireClient().sendMessage(options);
  }

  acknowledgeIncoming(
    requestId: string,
    messageId: string,
    result: { delivered: true } | { delivered: false; error: string },
  ): void {
    try {
      this.requireClient().acknowledgeIncoming(requestId, messageId, result);
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
    client.on(INCOMING_SESSION_MESSAGE_EVENT, this.onIncoming);
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

    const delay = RECONNECT_DELAYS_MS[this.reconnectDelayIndex] ?? 30_000;
    this.reconnectDelayIndex = Math.min(
      this.reconnectDelayIndex + 1,
      RECONNECT_DELAYS_MS.length - 1,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.ensureConnectedNow().catch(() => {});
    }, delay);
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
