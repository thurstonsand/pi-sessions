import { type Static, Type } from "typebox";

const SESSION_INFO_SCHEMA = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.Optional(Type.String()),
  cwd: Type.String(),
});

export const SESSION_MESSAGE_PAYLOAD_SCHEMA = Type.Object({
  messageId: Type.String(),
  source: SESSION_INFO_SCHEMA,
  target: SESSION_INFO_SCHEMA,
  body: Type.String(),
  requestResponse: Type.Optional(Type.Boolean()),
  sentAt: Type.String(),
  sourceToolCallId: Type.Optional(Type.String()),
});

const REGISTER_CLIENT_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("register"),
  session: SESSION_INFO_SCHEMA,
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
  messageId: Type.String(),
  target: Type.String(),
  body: Type.String(),
  requestResponse: Type.Optional(Type.Boolean()),
  sentAt: Type.String(),
  sourceToolCallId: Type.Optional(Type.String()),
});
const INCOMING_ACK_CLIENT_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("incoming_ack"),
  requestId: Type.String(),
  messageId: Type.String(),
  delivered: Type.Boolean(),
  error: Type.Optional(Type.String()),
});

const REGISTERED_BROKER_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("registered"),
  session: SESSION_INFO_SCHEMA,
});
const REGISTER_FAILED_BROKER_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("register_failed"),
  reason: Type.String(),
});
const SESSIONS_BROKER_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("sessions"),
  requestId: Type.String(),
  sessions: Type.Array(SESSION_INFO_SCHEMA),
});
const INCOMING_BROKER_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("incoming"),
  requestId: Type.String(),
  message: SESSION_MESSAGE_PAYLOAD_SCHEMA,
});
const SEND_RESULT_BROKER_FRAME_SCHEMA = Type.Object({
  type: Type.Literal("send_result"),
  requestId: Type.String(),
  messageId: Type.String(),
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

export type SessionMessagingSessionInfo = Static<typeof SESSION_INFO_SCHEMA>;
export type SessionMessagePayload = Static<typeof SESSION_MESSAGE_PAYLOAD_SCHEMA>;
export type SessionMessagingSendClientFrame = Static<typeof SEND_CLIENT_FRAME_SCHEMA>;
export type SessionMessagingIncomingAckClientFrame = Static<
  typeof INCOMING_ACK_CLIENT_FRAME_SCHEMA
>;
export type SessionMessagingClientFrame = Static<typeof CLIENT_FRAME_SCHEMA>;
export type SessionMessagingBrokerFrame = Static<typeof BROKER_FRAME_SCHEMA>;
