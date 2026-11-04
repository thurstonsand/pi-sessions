import { type Static, Type } from "typebox";
import { upgradeLegacyEntry } from "../../shared/legacy-entry.ts";
import { safeParseTypeBoxValue } from "../../shared/typebox.ts";

const RECEIVED_MESSAGE_ENDPOINT_SCHEMA = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
});

export const SEND_MESSAGE_PARAMS = Type.Object({
  session: Type.String({ description: "Pi session UUID." }),
  message: Type.String({
    description: "Self-contained: the recipient doesn't see this conversation.",
  }),
  report_back: Type.Boolean({
    description: "Whether the recipient should reply to you.",
  }),
});

export const SEND_MESSAGE_TOOL_DETAILS_SCHEMA = Type.Object({
  delivered: Type.Literal(true),
  messageId: Type.String(),
  target: RECEIVED_MESSAGE_ENDPOINT_SCHEMA,
  relation: Type.Optional(Type.String()),
});

export const CANCEL_SESSION_PARAMS = Type.Object({
  session: Type.String({ description: "Bare UUID for the live session to cancel." }),
});

export const CANCEL_SESSION_TOOL_DETAILS_SCHEMA = Type.Union([
  Type.Object({
    kind: Type.Literal("transport"),
    delivered: Type.Literal(true),
    cancelId: Type.String(),
    target: RECEIVED_MESSAGE_ENDPOINT_SCHEMA,
    relation: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("managed"),
    accepted: Type.Literal(true),
    target: RECEIVED_MESSAGE_ENDPOINT_SCHEMA,
    state: Type.String(),
    cancelId: Type.Optional(Type.String()),
    relation: Type.Optional(Type.String()),
  }),
]);

export const RECEIVED_MESSAGE_ENTRY_SCHEMA = Type.Object({
  messageId: Type.String(),
  source: RECEIVED_MESSAGE_ENDPOINT_SCHEMA,
  target: RECEIVED_MESSAGE_ENDPOINT_SCHEMA,
  body: Type.String(),
  sentAt: Type.String(),
  receivedAt: Type.String(),
  reportBack: Type.Optional(Type.Boolean()),
  sourceToolCallId: Type.Optional(Type.String()),
  relation: Type.Optional(Type.String()),
});

export type SendMessageParams = Static<typeof SEND_MESSAGE_PARAMS>;
export type SendMessageToolDetails = Static<typeof SEND_MESSAGE_TOOL_DETAILS_SCHEMA>;
export type CancelSessionParams = Static<typeof CANCEL_SESSION_PARAMS>;
export type CancelSessionToolDetails = Static<typeof CANCEL_SESSION_TOOL_DETAILS_SCHEMA>;
export type ReceivedMessageEndpoint = Static<typeof RECEIVED_MESSAGE_ENDPOINT_SCHEMA>;
export type ReceivedMessageEntry = Static<typeof RECEIVED_MESSAGE_ENTRY_SCHEMA>;

export function parseReceivedMessageEntry(value: unknown): ReceivedMessageEntry | undefined {
  return safeParseTypeBoxValue(RECEIVED_MESSAGE_ENTRY_SCHEMA, upgradeLegacyEntry(value));
}
