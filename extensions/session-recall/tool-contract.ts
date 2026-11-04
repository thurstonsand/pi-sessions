import { type Static, Type } from "typebox";

export const SESSION_RECALL_RELEVANT_FILE_SCHEMA = Type.Object({
  path: Type.String(),
  reason: Type.String(),
});

export const SESSION_RECALL_PROGRESS_DETAILS_SCHEMA = Type.Object({
  question: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  sessionName: Type.String(),
  sessionPath: Type.String({ minLength: 1 }),
});

export const SESSION_RECALL_RESULT_DETAILS_SCHEMA = Type.Object({
  answer: Type.String({ minLength: 1 }),
  debugSessionPath: Type.Optional(Type.String({ minLength: 1 })),
  question: Type.String({ minLength: 1 }),
  relevantFiles: Type.Array(SESSION_RECALL_RELEVANT_FILE_SCHEMA),
  sessionId: Type.String({ minLength: 1 }),
  sessionName: Type.String(),
  sessionPath: Type.String({ minLength: 1 }),
});

export const SESSION_RECALL_OUTPUT_SCHEMA = Type.Object({
  session_id: Type.String(),
  session_name: Type.String(),
  answer: Type.String(),
  relevant_files: Type.Array(SESSION_RECALL_RELEVANT_FILE_SCHEMA),
});

export type SessionRecallRelevantFile = Static<typeof SESSION_RECALL_RELEVANT_FILE_SCHEMA>;
export type SessionRecallProgressDetails = Static<typeof SESSION_RECALL_PROGRESS_DETAILS_SCHEMA>;
export type SessionRecallResultDetails = Static<typeof SESSION_RECALL_RESULT_DETAILS_SCHEMA>;
export type SessionRecallOutput = Static<typeof SESSION_RECALL_OUTPUT_SCHEMA>;
