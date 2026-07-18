import { type Static, Type } from "typebox";

const OUTBOUND_MESSAGE_ENVELOPE_SCHEMA = Type.Object({
  kind: Type.Literal("message"),
  messageId: Type.String(),
  body: Type.String(),
  requestResponse: Type.Optional(Type.Boolean()),
  sentAt: Type.String(),
  sourceToolCallId: Type.Optional(Type.String()),
});
const OUTBOUND_CANCEL_ENVELOPE_SCHEMA = Type.Object({
  kind: Type.Literal("cancel"),
  cancelId: Type.String(),
  sentAt: Type.String(),
});

export const OUTBOUND_SESSION_ENVELOPE_SCHEMA = Type.Union([
  OUTBOUND_MESSAGE_ENVELOPE_SCHEMA,
  OUTBOUND_CANCEL_ENVELOPE_SCHEMA,
]);

export const SESSION_MESSAGE_ENVELOPE_SCHEMA = Type.Object({
  kind: Type.Literal("message"),
  messageId: Type.String(),
  source: Type.String(),
  target: Type.String(),
  body: Type.String(),
  requestResponse: Type.Optional(Type.Boolean()),
  sentAt: Type.String(),
  sourceToolCallId: Type.Optional(Type.String()),
});
export const SESSION_CANCEL_ENVELOPE_SCHEMA = Type.Object({
  kind: Type.Literal("cancel"),
  cancelId: Type.String(),
  source: Type.String(),
  target: Type.String(),
  sentAt: Type.String(),
});

export const SESSION_ENVELOPE_SCHEMA = Type.Union([
  SESSION_MESSAGE_ENVELOPE_SCHEMA,
  SESSION_CANCEL_ENVELOPE_SCHEMA,
]);

const REGISTER_CLIENT_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("register"),
  sessionId: Type.String(),
});
const UNREGISTER_CLIENT_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("unregister"),
});
const LIST_CLIENT_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("list"),
  requestId: Type.String(),
});
const SEND_CLIENT_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("send"),
  requestId: Type.String(),
  target: Type.String(),
  envelope: OUTBOUND_SESSION_ENVELOPE_SCHEMA,
});
const INCOMING_ACK_CLIENT_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("incoming_ack"),
  requestId: Type.String(),
  delivered: Type.Boolean(),
  error: Type.Optional(Type.String()),
});

const REGISTERED_BROKER_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("registered"),
  sessionId: Type.String(),
});
const REGISTER_FAILED_BROKER_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("register_failed"),
  reason: Type.String(),
});
const SESSIONS_BROKER_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("sessions"),
  requestId: Type.String(),
  sessionIds: Type.Array(Type.String()),
});
const INCOMING_BROKER_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("incoming"),
  requestId: Type.String(),
  envelope: SESSION_ENVELOPE_SCHEMA,
});
const SEND_RESULT_BROKER_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("send_result"),
  requestId: Type.String(),
  delivered: Type.Boolean(),
  error: Type.Optional(Type.String()),
});
const ERROR_BROKER_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("error"),
  message: Type.String(),
});

export const CLIENT_FRAME_SCHEMA = Type.Union([
  REGISTER_CLIENT_FRAME_SCHEMA,
  UNREGISTER_CLIENT_FRAME_SCHEMA,
  LIST_CLIENT_FRAME_SCHEMA,
  SEND_CLIENT_FRAME_SCHEMA,
  INCOMING_ACK_CLIENT_FRAME_SCHEMA,
]);

export const BROKER_FRAME_SCHEMA = Type.Union([
  REGISTERED_BROKER_FRAME_SCHEMA,
  REGISTER_FAILED_BROKER_FRAME_SCHEMA,
  SESSIONS_BROKER_FRAME_SCHEMA,
  INCOMING_BROKER_FRAME_SCHEMA,
  SEND_RESULT_BROKER_FRAME_SCHEMA,
  ERROR_BROKER_FRAME_SCHEMA,
]);

export type OutboundSessionMessageEnvelope = Static<typeof OUTBOUND_MESSAGE_ENVELOPE_SCHEMA>;
export type OutboundSessionCancelEnvelope = Static<typeof OUTBOUND_CANCEL_ENVELOPE_SCHEMA>;
export type OutboundSessionEnvelope = Static<typeof OUTBOUND_SESSION_ENVELOPE_SCHEMA>;
export type SessionMessageEnvelope = Static<typeof SESSION_MESSAGE_ENVELOPE_SCHEMA>;
export type SessionCancelEnvelope = Static<typeof SESSION_CANCEL_ENVELOPE_SCHEMA>;
export type SessionEnvelope = Static<typeof SESSION_ENVELOPE_SCHEMA>;
export type SessionMessagingSendClientFrame = Static<typeof SEND_CLIENT_FRAME_SCHEMA>;
export type SessionMessagingIncomingAckClientFrame = Static<
  typeof INCOMING_ACK_CLIENT_FRAME_SCHEMA
>;
export type SessionMessagingClientFrame = Static<typeof CLIENT_FRAME_SCHEMA>;
export type SessionMessagingBrokerFrame = Static<typeof BROKER_FRAME_SCHEMA>;
