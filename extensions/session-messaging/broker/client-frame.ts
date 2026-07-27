// The broker runs as a detached raw-Node process with nothing installed next to
// it, so client frames are validated by hand rather than against the TypeBox
// schemas in shared/session-broker/protocol.ts. The broker only routes
// envelopes, so it validates the routing fields and treats `envelope` as an
// opaque object; the receiving client validates the envelope body in full.

export interface RoutedEnvelope {
  [key: string]: unknown;
}

export interface RegisterClientFrame {
  type: "register";
  sessionId: string;
}

export interface UnregisterClientFrame {
  type: "unregister";
}

export interface ListClientFrame {
  type: "list";
  requestId: string;
}

export interface SendClientFrame {
  type: "send";
  requestId: string;
  target: string;
  envelope: RoutedEnvelope;
}

export interface IncomingAckClientFrame {
  type: "incoming_ack";
  requestId: string;
  delivered: boolean;
  error?: string;
}

export type BrokerClientFrame =
  | RegisterClientFrame
  | UnregisterClientFrame
  | ListClientFrame
  | SendClientFrame
  | IncomingAckClientFrame;

const CONTEXT = "Invalid session messaging client frame";

export function parseClientFrame(value: unknown): BrokerClientFrame {
  const frame = requireObject(value, "/");

  switch (frame.type) {
    case "register":
      return { type: "register", sessionId: requireString(frame.sessionId, "/sessionId") };
    case "unregister":
      return { type: "unregister" };
    case "list":
      return { type: "list", requestId: requireString(frame.requestId, "/requestId") };
    case "send":
      return {
        type: "send",
        requestId: requireString(frame.requestId, "/requestId"),
        target: requireString(frame.target, "/target"),
        envelope: requireObject(frame.envelope, "/envelope"),
      };
    case "incoming_ack": {
      const error = optionalString(frame.error, "/error");
      return {
        type: "incoming_ack",
        requestId: requireString(frame.requestId, "/requestId"),
        delivered: requireBoolean(frame.delivered, "/delivered"),
        ...(error === undefined ? {} : { error }),
      };
    }
    default:
      throw invalid("/type", "expected a known client frame type");
  }
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(path, "expected an object");
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw invalid(path, "expected a string");
  }

  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw invalid(path, "expected a boolean");
  }

  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireString(value, path);
}

function invalid(path: string, message: string): Error {
  return new Error(`${CONTEXT}: ${path} ${message}`);
}
