export const HANDOFF_METADATA_CUSTOM_TYPE = "pi-sessions.handoff";

export interface HandoffSessionMetadata {
  origin: "handoff";
  goal: string;
  nextTask: string;
}

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
