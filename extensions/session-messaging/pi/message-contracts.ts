import { type Static, Type } from "typebox";

const RECEIVED_MESSAGE_ENDPOINT_SCHEMA = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
});

export const SEND_MESSAGE_PARAMS = Type.Object({
  session: Type.String({ description: "Pi session UUID." }),
  message: Type.String({
    description: "Message to send to the target session.",
  }),
  requestResponse: Type.Optional(
    Type.Boolean({
      description:
        "Whether the target session should respond with completion/results back to this session.",
    }),
  ),
});

export const SEND_MESSAGE_TOOL_DETAILS_SCHEMA = Type.Object({
  delivered: Type.Literal(true),
  messageId: Type.String(),
  target: RECEIVED_MESSAGE_ENDPOINT_SCHEMA,
  relation: Type.Optional(Type.String()),
});

export const RECEIVED_MESSAGE_ENTRY_SCHEMA = Type.Object({
  messageId: Type.String(),
  source: RECEIVED_MESSAGE_ENDPOINT_SCHEMA,
  target: RECEIVED_MESSAGE_ENDPOINT_SCHEMA,
  body: Type.String(),
  sentAt: Type.String(),
  receivedAt: Type.String(),
  requestResponse: Type.Optional(Type.Boolean()),
  sourceToolCallId: Type.Optional(Type.String()),
  relation: Type.Optional(Type.String()),
});

export type SendMessageParams = Static<typeof SEND_MESSAGE_PARAMS>;
export type SendMessageToolDetails = Static<typeof SEND_MESSAGE_TOOL_DETAILS_SCHEMA>;
export type ReceivedMessageEndpoint = Static<typeof RECEIVED_MESSAGE_ENDPOINT_SCHEMA>;
export type ReceivedMessageEntry = Static<typeof RECEIVED_MESSAGE_ENTRY_SCHEMA>;
