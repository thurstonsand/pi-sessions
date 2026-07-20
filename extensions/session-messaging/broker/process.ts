import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { readFrames, writeFrame } from "../../shared/session-broker/framing.ts";
import {
  CLIENT_FRAME_SCHEMA,
  type OutboundSessionEnvelope,
  type SessionEnvelope,
  type SessionMessagingClientFrame,
  type SessionMessagingIncomingAckClientFrame,
  type SessionMessagingSendClientFrame,
} from "../../shared/session-broker/protocol.ts";
import {
  getSessionMessagingDir,
  getSessionMessagingSocketPath,
} from "../../shared/session-broker/socket-path.ts";

const SEND_TIMEOUT_MS = 10_000;
const EXIT_IDLE_MS = 5_000;
const KEEPALIVE_DELAY_MS = 5_000;

const messagingDir = getSessionMessagingDir();
const socketPath = getSessionMessagingSocketPath();
const pidPath = join(messagingDir, "broker.pid");

interface PendingSend {
  source: Socket;
  target: Socket;
  timeout: NodeJS.Timeout;
  targetSessionId: string;
}

const sessions = new Map<string, Socket>();
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

function resolveTarget(target: string): { sessionId: string; socket: Socket } | { error: string } {
  const socket = sessions.get(target);
  if (socket) return { sessionId: target, socket };

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
      const existing = sessions.get(message.sessionId);
      if (existing && existing !== socket && !existing.destroyed) {
        writeFrame(socket, {
          type: "register_failed",
          reason:
            "Session messaging unavailable: this session is already registered by another live Pi process.",
        });
        socket.end();
        return;
      }

      clearIdleExit();
      setSessionId(message.sessionId);
      sessions.set(message.sessionId, socket);
      socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);
      writeFrame(socket, { type: "registered", sessionId: message.sessionId });
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
        sessionIds: [...sessions.keys()],
      });
      break;

    case "send":
      handleSend(socket, currentSessionId, message);
      break;

    case "incoming_ack":
      handleIncomingAck(socket, message);
      break;
  }
}

function handleSend(
  socket: Socket,
  currentSessionId: string | undefined,
  message: SessionMessagingSendClientFrame,
): void {
  const source = currentSessionId ? sessions.get(currentSessionId) : undefined;

  if (!currentSessionId || !source) {
    writeFrame(socket, {
      type: "send_result",
      requestId: message.requestId,
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
      delivered: false,
      reason: "no_session",
      error: resolved.error,
    });
    return;
  }

  if (resolved.sessionId === currentSessionId) {
    writeFrame(socket, {
      type: "send_result",
      requestId: message.requestId,
      delivered: false,
      error: "Cannot send a session envelope to the current session.",
    });
    return;
  }

  const timeout = setTimeout(() => {
    pendingSends.delete(message.requestId);
    writeFrame(socket, {
      type: "send_result",
      requestId: message.requestId,
      delivered: false,
      error: "Timed out waiting for target session to accept the envelope.",
    });
  }, SEND_TIMEOUT_MS);
  pendingSends.set(message.requestId, {
    source: socket,
    target: resolved.socket,
    timeout,
    targetSessionId: resolved.sessionId,
  });

  writeFrame(resolved.socket, {
    type: "incoming",
    requestId: message.requestId,
    envelope: stampEnvelope(message.envelope, currentSessionId, resolved.sessionId),
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
      delivered: false,
      reason: "disconnected",
      error: "Target disconnected before accepting the envelope.",
    });
  }
}

function handleIncomingAck(socket: Socket, message: SessionMessagingIncomingAckClientFrame): void {
  const pending = pendingSends.get(message.requestId);
  if (!pending || pending.target !== socket) return;

  clearTimeout(pending.timeout);
  pendingSends.delete(message.requestId);
  writeFrame(pending.source, {
    type: "send_result",
    requestId: message.requestId,
    delivered: message.delivered,
    ...(message.error === undefined ? {} : { error: message.error }),
  });
}

function stampEnvelope(
  envelope: OutboundSessionEnvelope,
  source: string,
  target: string,
): SessionEnvelope {
  return { ...envelope, source, target };
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
  for (const socket of sessions.values()) socket.end();
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
