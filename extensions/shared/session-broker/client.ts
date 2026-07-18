import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import { readFrames, writeFrame } from "./framing.ts";
import {
  BROKER_FRAME_SCHEMA,
  type OutboundSessionEnvelope,
  type SessionMessagingBrokerFrame,
} from "./protocol.ts";
import { getSessionMessagingSocketPath } from "./socket-path.ts";

export const INCOMING_SESSION_ENVELOPE_EVENT = "session_messaging.incoming";

const REQUEST_TIMEOUT_MS = 10_000;
const SOCKET_PATH = getSessionMessagingSocketPath();

interface PendingListRequest {
  resolve(sessionIds: string[]): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

interface PendingSendRequest {
  resolve(result: SessionEnvelopeSendResult): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export interface SessionEnvelopeSendResult {
  delivered: boolean;
  error?: string | undefined;
}

export interface SendSessionEnvelopeOptions {
  target: string;
  envelope: OutboundSessionEnvelope;
}

export class SessionMessagingClient extends EventEmitter {
  private socket: net.Socket | undefined;
  private sessionId: string | undefined;
  private pendingLists = new Map<string, PendingListRequest>();
  private pendingSends = new Map<string, PendingSendRequest>();

  get isConnected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed && this.socket.writable && this.sessionId);
  }

  get registeredSessionId(): string | undefined {
    return this.sessionId;
  }

  async connect(sessionId: string): Promise<void> {
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
      writeFrame(socket, { type: "register", sessionId });
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

  listSessionIds(): Promise<string[]> {
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

  sendEnvelope(options: SendSessionEnvelopeOptions): Promise<SessionEnvelopeSendResult> {
    const socket = this.requireSocket();
    const requestId = randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSends.delete(requestId);
        reject(new Error("Session envelope send timed out."));
      }, REQUEST_TIMEOUT_MS + 1_000);
      this.pendingSends.set(requestId, { resolve, reject, timeout });
      writeFrame(socket, {
        type: "send",
        requestId,
        target: options.target,
        envelope: options.envelope,
      });
    });
  }

  acknowledgeIncoming(
    requestId: string,
    result: { delivered: true } | { delivered: false; error: string },
  ): void {
    const socket = this.requireSocket();
    writeFrame(socket, {
      type: "incoming_ack",
      requestId,
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
        this.sessionId = frame.sessionId;
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
        pending.resolve(frame.sessionIds);
        break;
      }
      case "incoming":
        this.emit(INCOMING_SESSION_ENVELOPE_EVENT, frame.requestId, frame.envelope);
        break;
      case "send_result": {
        const pending = this.pendingSends.get(frame.requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingSends.delete(frame.requestId);
        pending.resolve({
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
    if (!this.socket || this.socket.destroyed || !this.socket.writable || !this.sessionId) {
      throw new Error("Session messaging is not connected.");
    }

    return this.socket;
  }

  private cleanup(): void {
    this.sessionId = undefined;
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
