import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import { readFrames, writeFrame } from "../shared/framing.ts";
import {
  BROKER_FRAME_SCHEMA,
  type SessionMessagingBrokerFrame,
  type SessionMessagingSessionInfo,
} from "../shared/protocol.ts";
import { getSessionMessagingSocketPath } from "../shared/socket-path.ts";
export const INCOMING_SESSION_MESSAGE_EVENT = "session_messaging.incoming_message";

const REQUEST_TIMEOUT_MS = 10_000;
const SOCKET_PATH = getSessionMessagingSocketPath();

interface PendingListRequest {
  resolve(sessions: SessionMessagingSessionInfo[]): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

interface PendingSendRequest {
  resolve(result: SessionMessageSendResult): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export interface SessionMessageSendResult {
  messageId: string;
  delivered: boolean;
  error?: string | undefined;
}

export interface SendSessionMessageOptions {
  messageId: string;
  target: string;
  body: string;
  sentAt: string;
  requestResponse?: boolean | undefined;
  sourceToolCallId?: string | undefined;
}

export class SessionMessagingClient extends EventEmitter {
  private socket: net.Socket | undefined;
  private session: SessionMessagingSessionInfo | undefined;
  private pendingLists = new Map<string, PendingListRequest>();
  private pendingSends = new Map<string, PendingSendRequest>();

  get isConnected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed && this.socket.writable && this.session);
  }

  get registeredSession(): SessionMessagingSessionInfo | undefined {
    return this.session;
  }

  async connect(session: SessionMessagingSessionInfo): Promise<void> {
    if (this.isConnected) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(SOCKET_PATH);
      this.socket = socket;
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(new Error("Session messaging broker connection timed out."));
      }, REQUEST_TIMEOUT_MS);

      const cleanup = (): void => {
        clearTimeout(timeout);
        socket.off("error", onError);
        socket.off("close", onClose);
        this.off("registered", onRegistered);
        this.off("register_failed", onRegisterFailed);
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };

      const onError = (error: Error): void => fail(error);
      const onClose = (): void =>
        fail(new Error("Session messaging broker closed before registration."));
      const onRegistered = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.on("close", () => {
          if (this.socket === socket) {
            this.cleanup();
            this.emit("disconnect");
          }
        });
        resolve();
      };
      const onRegisterFailed = (reason: string): void => fail(new Error(reason));

      socket.on("error", onError);
      socket.on("close", onClose);
      this.once("registered", onRegistered);
      this.once("register_failed", onRegisterFailed);
      void this.readSocket(socket);

      socket.setKeepAlive(true, 5_000);
      writeFrame(socket, { type: "register", session });
    });
  }

  disconnect(): void {
    if (this.socket && !this.socket.destroyed) {
      if (!this.socket.writableEnded) {
        try {
          writeFrame(this.socket, { type: "unregister" });
        } catch {}
      }
      this.socket.end();
    }
    this.cleanup();
  }

  listSessions(): Promise<SessionMessagingSessionInfo[]> {
    const socket = this.requireSocket();
    const requestId = randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingLists.delete(requestId);
        reject(new Error("Session live list timed out."));
      }, REQUEST_TIMEOUT_MS);
      this.pendingLists.set(requestId, { resolve, reject, timeout });
      writeFrame(socket, { type: "list", requestId });
    });
  }

  sendMessage(options: SendSessionMessageOptions): Promise<SessionMessageSendResult> {
    const socket = this.requireSocket();
    const requestId = randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSends.delete(requestId);
        reject(new Error("Session message send timed out."));
      }, REQUEST_TIMEOUT_MS + 1_000);
      this.pendingSends.set(requestId, { resolve, reject, timeout });
      writeFrame(socket, {
        type: "send",
        requestId,
        messageId: options.messageId,
        target: options.target,
        body: options.body,
        requestResponse: options.requestResponse,
        sourceToolCallId: options.sourceToolCallId,
        sentAt: options.sentAt,
      });
    });
  }

  acknowledgeIncoming(
    requestId: string,
    messageId: string,
    result: { delivered: true } | { delivered: false; error: string },
  ): void {
    const socket = this.requireSocket();
    writeFrame(socket, {
      type: "incoming_ack",
      requestId,
      messageId,
      delivered: result.delivered,
      error: result.delivered ? undefined : result.error,
    });
  }

  private async readSocket(socket: net.Socket): Promise<void> {
    try {
      for await (const frame of readFrames(
        socket,
        BROKER_FRAME_SCHEMA,
        "Invalid session messaging broker frame",
      )) {
        this.handleFrame(frame);
      }
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleFrame(frame: SessionMessagingBrokerFrame): void {
    switch (frame.type) {
      case "registered":
        this.session = frame.session;
        this.emit("registered");
        break;
      case "register_failed":
        this.emit("register_failed", frame.reason);
        break;
      case "sessions": {
        const pending = this.pendingLists.get(frame.requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingLists.delete(frame.requestId);
        pending.resolve(frame.sessions);
        break;
      }
      case "incoming":
        this.emit(INCOMING_SESSION_MESSAGE_EVENT, frame.requestId, frame.message);
        break;
      case "send_result": {
        const pending = this.pendingSends.get(frame.requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingSends.delete(frame.requestId);
        pending.resolve({
          messageId: frame.messageId,
          delivered: frame.delivered,
          error: frame.error,
        });
        break;
      }
      case "error":
        this.socket?.destroy(new Error(frame.message));
        break;
    }
  }

  private requireSocket(): net.Socket {
    if (!this.socket || this.socket.destroyed || !this.socket.writable || !this.session) {
      throw new Error("Session messaging is not connected.");
    }

    return this.socket;
  }

  private cleanup(): void {
    this.session = undefined;
    for (const pending of this.pendingLists.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Session messaging disconnected."));
    }
    this.pendingLists.clear();
    for (const pending of this.pendingSends.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Session messaging disconnected."));
    }
    this.pendingSends.clear();
  }
}
