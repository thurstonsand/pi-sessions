import { type Static, Type } from "@sinclair/typebox";
import { safeParseTypeBoxValue } from "../shared/typebox.js";

export const HANDOFF_METADATA_CUSTOM_TYPE = "pi-sessions.handoff";
export const HANDOFF_SESSION_METADATA_SCHEMA = Type.Object({
  origin: Type.Literal("handoff"),
  goal: Type.String(),
  nextTask: Type.String(),
});

export type HandoffSessionMetadata = Static<typeof HANDOFF_SESSION_METADATA_SCHEMA>;

export function createHandoffSessionMetadata(
  goal: string,
  nextTask: string,
): HandoffSessionMetadata {
  return {
    origin: "handoff",
    goal: goal.trim(),
    nextTask: nextTask.trim() || goal.trim(),
  };
}

export function parseHandoffSessionMetadata(value: unknown): HandoffSessionMetadata | undefined {
  return safeParseTypeBoxValue(HANDOFF_SESSION_METADATA_SCHEMA, value);
}
