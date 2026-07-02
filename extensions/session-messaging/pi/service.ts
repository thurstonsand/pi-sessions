import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionLineageRelation } from "../../shared/session-index/index.ts";
import {
  getIndexStatus,
  getLineageRelationMap,
  INDEX_SCHEMA_VERSION,
  openIndexDatabase,
} from "../../shared/session-index/index.ts";
import { spawnSessionMessagingBrokerIfNeeded } from "../broker/spawn.ts";
import type { SessionMessagePayload, SessionMessagingSessionInfo } from "../shared/protocol.ts";
import {
  INCOMING_SESSION_MESSAGE_EVENT,
  type SessionMessageSendResult,
  SessionMessagingClient,
} from "./client.ts";
import type { IncomingSessionMessageRuntime } from "./incoming-runtime.ts";

export const MESSAGE_SENT_CUSTOM_TYPE = "pi-sessions.message_sent";

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;

export interface LiveSessionRow extends SessionMessagingSessionInfo {
  relation?: SessionLineageRelation | undefined;
}

export interface SendMessageRequest {
  target: string;
  body: string;
  requestResponse?: boolean | undefined;
  sourceToolCallId?: string | undefined;
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
    this.refreshCachedRelations(ctx.sessionManager.getSessionId());
    await this.connection.start(buildSessionInfo(ctx));
  }

  stop(): void {
    this.relationBySessionId.clear();
    this.connection.stop();
  }

  async listLiveSessions(ctx: ExtensionContext): Promise<LiveSessionRow[]> {
    const sessions = await this.connection.listSessions();
    this.refreshCachedRelations(ctx.sessionManager.getSessionId());
    const currentSessionId = ctx.sessionManager.getSessionId();
    return sessions
      .filter((session) => session.sessionId !== currentSessionId)
      .map(
        (session): LiveSessionRow => ({
          ...session,
          relation: this.getCachedRelationTo(session.sessionId),
        }),
      );
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
    const relation = this.getCachedRelationTo(message.source.sessionId, true);
    const result = this.incomingRuntime.deliver(message, relation);
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

    const identity = this.connection.currentIdentity;
    if (!identity) {
      throw new Error("Session messaging is not active.");
    }

    this.refreshCachedRelations(identity.sessionId);
    if (!this.relationBySessionId.has(sessionId)) {
      this.relationBySessionId.set(sessionId, undefined);
    }

    return this.relationBySessionId.get(sessionId);
  }

  private refreshCachedRelations(currentSessionId: string): void {
    const previousRelations = this.relationBySessionId;
    const nextRelations = getRelationMapForSession(this.indexPath, currentSessionId);

    for (const [sessionId, relation] of previousRelations) {
      if (relation === undefined && !nextRelations.has(sessionId)) {
        nextRelations.set(sessionId, undefined);
      }
    }

    this.relationBySessionId = nextRelations;
  }
}

class BrokerConnection {
  private client: SessionMessagingClient | undefined;
  private identity: SessionMessagingSessionInfo | undefined;
  private active = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelayIndex = 0;
  private connectPromise: Promise<void> | undefined;

  constructor(
    private readonly onIncoming: (requestId: string, message: SessionMessagePayload) => void,
  ) {}

  get currentIdentity(): SessionMessagingSessionInfo | undefined {
    return this.identity;
  }

  async start(identity: SessionMessagingSessionInfo): Promise<void> {
    this.active = true;
    this.identity = identity;
    await this.ensureConnectedNow();
  }

  stop(): void {
    this.active = false;
    this.identity = undefined;
    this.clearReconnectTimer();
    this.client?.disconnect();
    this.client = undefined;
    this.connectPromise = undefined;
  }

  async listSessions(): Promise<SessionMessagingSessionInfo[]> {
    await this.ensureConnectedNow();
    return this.requireClient().listSessions();
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
    if (!this.active || !this.identity) {
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
    const identity = this.identity;
    if (!identity) {
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

    await client.connect(identity);
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

function buildSessionInfo(ctx: ExtensionContext): SessionMessagingSessionInfo {
  const sessionName = ctx.sessionManager.getSessionName()?.trim();
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    ...(sessionName ? { sessionName } : {}),
    cwd: ctx.cwd,
  };
}

function getRelationMapForSession(
  indexPath: string,
  sessionId: string,
): Map<string, SessionLineageRelation | undefined> {
  const status = getIndexStatus(indexPath);
  if (!status.exists || status.schemaVersion !== INDEX_SCHEMA_VERSION) {
    return new Map();
  }

  const db = openIndexDatabase(status.dbPath, { create: false });
  try {
    return new Map(getLineageRelationMap(db, sessionId));
  } finally {
    db.close();
  }
}
