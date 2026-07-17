import { type Static, Type } from "typebox";

export const SESSION_ASK_RELEVANT_FILE_SCHEMA = Type.Object({
  path: Type.String(),
  reason: Type.String(),
});

export const SESSION_ASK_PROGRESS_DETAILS_SCHEMA = Type.Object({
  question: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  sessionName: Type.String(),
  sessionPath: Type.String({ minLength: 1 }),
});

export const SESSION_ASK_RESULT_DETAILS_SCHEMA = Type.Object({
  answer: Type.String({ minLength: 1 }),
  debugSessionPath: Type.Optional(Type.String({ minLength: 1 })),
  question: Type.String({ minLength: 1 }),
  relevantFiles: Type.Array(SESSION_ASK_RELEVANT_FILE_SCHEMA),
  sessionId: Type.String({ minLength: 1 }),
  sessionName: Type.String(),
  sessionPath: Type.String({ minLength: 1 }),
});

export type SessionAskRelevantFile = Static<typeof SESSION_ASK_RELEVANT_FILE_SCHEMA>;
export type SessionAskProgressDetails = Static<typeof SESSION_ASK_PROGRESS_DETAILS_SCHEMA>;
export type SessionAskResultDetails = Static<typeof SESSION_ASK_RESULT_DETAILS_SCHEMA>;
