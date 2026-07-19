import { type Static, Type } from "typebox";

export const TASK_REPORT_REFERENCE_SCHEMA = Type.Object({
  reference: Type.String({
    description:
      "A precise reference such as a file path and line range, symbol name, command, URL, session id, or external artifact.",
  }),
  description: Type.Optional(
    Type.String({
      description: "Why this reference matters or what evidence the parent should take from it.",
    }),
  ),
});

export const TASK_REPORT_SCHEMA = Type.Object({
  status: Type.Union(
    [
      Type.Literal("done", {
        description: "The delegated task or requested follow-up is complete.",
      }),
      Type.Literal("blocked", {
        description:
          "The task cannot continue without a specific decision, clarification, permission, dependency, or other action outside the scope of the task.",
      }),
      Type.Literal("incomplete", {
        description:
          "Useful work was performed, but the requested result could not be completed and it's uncertain what should be done to reach completion.",
      }),
    ],
    { description: "The subagent's assessment of the task at the end of this turn." },
  ),
  summary: Type.String({
    description:
      "A concise, 3-4 sentence self-contained account of the outcome and its most important evidence.",
  }),
  details: Type.Optional(
    Type.String({
      description:
        "Optional supporting context such as reasoning, implementation notes, validation performed, limitations, unexpected behavior or roadblocks, or failed approaches.",
    }),
  ),
  references: Type.Optional(
    Type.Array(TASK_REPORT_REFERENCE_SCHEMA, {
      description: "Supporting material for the report.",
    }),
  ),
  nextSteps: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional concrete actions that would extend or build on the state of the work. If blocked or incomplete, call out specifically what is causing the early return.",
    }),
  ),
});

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
const OUTBOUND_SUBAGENT_REPORT_ENVELOPE_SCHEMA = Type.Intersect([
  Type.Object({
    kind: Type.Literal("subagent_report"),
    reportId: Type.String(),
    sentAt: Type.String(),
  }),
  TASK_REPORT_SCHEMA,
]);

export const OUTBOUND_SESSION_ENVELOPE_SCHEMA = Type.Union([
  OUTBOUND_MESSAGE_ENVELOPE_SCHEMA,
  OUTBOUND_CANCEL_ENVELOPE_SCHEMA,
  OUTBOUND_SUBAGENT_REPORT_ENVELOPE_SCHEMA,
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
export const SESSION_SUBAGENT_REPORT_ENVELOPE_SCHEMA = Type.Intersect([
  Type.Object({
    kind: Type.Literal("subagent_report"),
    reportId: Type.String(),
    source: Type.String(),
    target: Type.String(),
    sentAt: Type.String(),
  }),
  TASK_REPORT_SCHEMA,
]);

export const SESSION_ENVELOPE_SCHEMA = Type.Union([
  SESSION_MESSAGE_ENVELOPE_SCHEMA,
  SESSION_CANCEL_ENVELOPE_SCHEMA,
  SESSION_SUBAGENT_REPORT_ENVELOPE_SCHEMA,
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

export type TaskReportReference = Static<typeof TASK_REPORT_REFERENCE_SCHEMA>;
export type TaskReport = Static<typeof TASK_REPORT_SCHEMA>;
export type OutboundSessionMessageEnvelope = Static<typeof OUTBOUND_MESSAGE_ENVELOPE_SCHEMA>;
export type OutboundSessionCancelEnvelope = Static<typeof OUTBOUND_CANCEL_ENVELOPE_SCHEMA>;
export type OutboundSubagentReportEnvelope = Static<
  typeof OUTBOUND_SUBAGENT_REPORT_ENVELOPE_SCHEMA
>;
export type OutboundSessionEnvelope = Static<typeof OUTBOUND_SESSION_ENVELOPE_SCHEMA>;
export type SessionMessageEnvelope = Static<typeof SESSION_MESSAGE_ENVELOPE_SCHEMA>;
export type SessionCancelEnvelope = Static<typeof SESSION_CANCEL_ENVELOPE_SCHEMA>;
export type SessionSubagentReportEnvelope = Static<typeof SESSION_SUBAGENT_REPORT_ENVELOPE_SCHEMA>;
export type SessionEnvelope = Static<typeof SESSION_ENVELOPE_SCHEMA>;
export type SessionMessagingSendClientFrame = Static<typeof SEND_CLIENT_FRAME_SCHEMA>;
export type SessionMessagingIncomingAckClientFrame = Static<
  typeof INCOMING_ACK_CLIENT_FRAME_SCHEMA
>;
export type SessionMessagingClientFrame = Static<typeof CLIENT_FRAME_SCHEMA>;
export type SessionMessagingBrokerFrame = Static<typeof BROKER_FRAME_SCHEMA>;
