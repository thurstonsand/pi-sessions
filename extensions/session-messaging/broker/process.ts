import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { readFrames, writeFrame } from "../shared/framing.ts";
import {
  CLIENT_FRAME_SCHEMA,
  type SessionMessagingClientFrame,
  type SessionMessagingIncomingAckClientFrame,
  type SessionMessagingSendClientFrame,
  type SessionMessagingSessionInfo,
} from "../shared/protocol.ts";
import { getSessionMessagingDir, getSessionMessagingSocketPath } from "../shared/socket-path.ts";

const SEND_TIMEOUT_MS = 10_000;
const EXIT_IDLE_MS = 5_000;
const KEEPALIVE_DELAY_MS = 5_000;

const messagingDir = getSessionMessagingDir();
const socketPath = getSessionMessagingSocketPath();
const pidPath = join(messagingDir, "broker.pid");

interface ConnectedSession {
  socket: Socket;
  session: SessionMessagingSessionInfo;
}

interface PendingSend {
  source: Socket;
  timeout: NodeJS.Timeout;
  messageId: string;
  targetSessionId: string;
}

const sessions = new Map<string, ConnectedSession>();
const pendingSends = new Map<string, PendingSend>();
let idleTimer: NodeJS.Timeout | undefined;
let server: ReturnType<typeof createServer> | undefined;

function closeWithError(socket: Socket, message: string): void {
  try {
    writeFrame(socket, { type: "error", message });
  } catch {}
  socket.destroy();
}

function scheduleIdleExit(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (sessions.size === 0) shutdown();
  }, EXIT_IDLE_MS);
}

function clearIdleExit(): void {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = undefined;
}

function unregister(sessionId: string | undefined): void {
  if (!sessionId) return;
  sessions.delete(sessionId);
  failPendingSendsTo(sessionId);
  if (sessions.size === 0) scheduleIdleExit();
}

function resolveTarget(target: string): { session: ConnectedSession } | { error: string } {
  const exact = sessions.get(target);
  if (exact) return { session: exact };

  return { error: `No live session found for id: ${target}` };
}

function handleFrame(
  socket: Socket,
  message: SessionMessagingClientFrame,
  getSessionId: () => string | undefined,
  setSessionId: (sessionId: string | undefined) => void,
): void {
  const currentSessionId = getSessionId();
  if (!currentSessionId && message.type !== "register") {
    closeWithError(socket, `Received ${message.type} before register.`);
    return;
  }

  switch (message.type) {
    case "register": {
      const existing = sessions.get(message.session.sessionId);
      if (existing && existing.socket !== socket && !existing.socket.destroyed) {
        writeFrame(socket, {
          type: "register_failed",
          reason:
            "Session messaging unavailable: this session is already registered by another live Pi process.",
        });
        socket.end();
        return;
      }

      clearIdleExit();
      setSessionId(message.session.sessionId);
      sessions.set(message.session.sessionId, { socket, session: message.session });
      socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);
      writeFrame(socket, { type: "registered", session: message.session });
      break;
    }

    case "unregister":
      unregister(currentSessionId);
      setSessionId(undefined);
      socket.end();
      break;

    case "list":
      writeFrame(socket, {
        type: "sessions",
        requestId: message.requestId,
        sessions: [...sessions.values()].map(({ session }) => session),
      });
      break;

    case "send":
      handleSend(socket, currentSessionId, message);
      break;

    case "incoming_ack":
      handleIncomingAck(message);
      break;
  }
}

function handleSend(
  socket: Socket,
  currentSessionId: string | undefined,
  message: SessionMessagingSendClientFrame,
): void {
  const source = currentSessionId ? sessions.get(currentSessionId) : undefined;
  const { messageId } = message;

  if (!source) {
    writeFrame(socket, {
      type: "send_result",
      requestId: message.requestId,
      messageId,
      delivered: false,
      error: "Sender session is not registered.",
    });
    return;
  }

  const resolved = resolveTarget(message.target);
  if ("error" in resolved) {
    writeFrame(socket, {
      type: "send_result",
      requestId: message.requestId,
      messageId,
      delivered: false,
      error: resolved.error,
    });
    return;
  }

  if (resolved.session.session.sessionId === source.session.sessionId) {
    writeFrame(socket, {
      type: "send_result",
      requestId: message.requestId,
      messageId,
      delivered: false,
      error: "Cannot send a session message to the current session.",
    });
    return;
  }

  const timeout = setTimeout(() => {
    pendingSends.delete(message.requestId);
    writeFrame(socket, {
      type: "send_result",
      requestId: message.requestId,
      messageId,
      delivered: false,
      error: "Timed out waiting for target session to accept the message.",
    });
  }, SEND_TIMEOUT_MS);
  pendingSends.set(message.requestId, {
    source: socket,
    timeout,
    messageId,
    targetSessionId: resolved.session.session.sessionId,
  });

  writeFrame(resolved.session.socket, {
    type: "incoming",
    requestId: message.requestId,
    message: {
      messageId,
      source: source.session,
      target: resolved.session.session,
      body: message.body,
      ...(message.requestResponse === undefined
        ? {}
        : { requestResponse: message.requestResponse }),
      sentAt: message.sentAt,
      ...(message.sourceToolCallId === undefined
        ? {}
        : { sourceToolCallId: message.sourceToolCallId }),
    },
  });
}

function failPendingSendsTo(targetSessionId: string): void {
  for (const [requestId, pending] of pendingSends) {
    if (pending.targetSessionId !== targetSessionId) {
      continue;
    }

    clearTimeout(pending.timeout);
    pendingSends.delete(requestId);
    writeFrame(pending.source, {
      type: "send_result",
      requestId,
      messageId: pending.messageId,
      delivered: false,
      error: "Target disconnected before accepting the message.",
    });
  }
}

function handleIncomingAck(message: SessionMessagingIncomingAckClientFrame): void {
  const pending = pendingSends.get(message.requestId);
  if (!pending) return;

  clearTimeout(pending.timeout);
  pendingSends.delete(message.requestId);
  writeFrame(pending.source, {
    type: "send_result",
    requestId: message.requestId,
    messageId: message.messageId,
    delivered: message.delivered,
    ...(message.error === undefined ? {} : { error: message.error }),
  });
}

function handleConnection(socket: Socket): void {
  let sessionId: string | undefined;
  socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);
  void readConnection(
    socket,
    () => sessionId,
    (nextSessionId) => {
      sessionId = nextSessionId;
    },
  );

  socket.on("close", () => {
    unregister(sessionId);
  });
  socket.on("error", () => {});
}

async function readConnection(
  socket: Socket,
  getSessionId: () => string | undefined,
  setSessionId: (sessionId: string | undefined) => void,
): Promise<void> {
  try {
    for await (const frame of readFrames(
      socket,
      CLIENT_FRAME_SCHEMA,
      "Invalid session messaging client frame",
    )) {
      handleFrame(socket, frame, getSessionId, setSessionId);
    }
  } catch (error) {
    closeWithError(socket, error instanceof Error ? error.message : String(error));
  }
}

function shutdown(): void {
  for (const { socket } of sessions.values()) socket.end();
  sessions.clear();
  for (const pending of pendingSends.values()) clearTimeout(pending.timeout);
  pendingSends.clear();
  if (server) server.close();
  if (process.platform !== "win32") {
    try {
      unlinkSync(socketPath);
    } catch {}
  }
  try {
    unlinkSync(pidPath);
  } catch {}
  process.exit(0);
}

mkdirSync(messagingDir, { recursive: true, mode: 0o700 });
if (process.platform !== "win32") {
  try {
    unlinkSync(socketPath);
  } catch {}
}
server = createServer(handleConnection);
server.listen(socketPath, () => {
  writeFileSync(pidPath, String(process.pid));
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
