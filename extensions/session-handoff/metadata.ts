import { Buffer } from "node:buffer";
import type { CustomEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { safeParseTypeBoxValue } from "../shared/typebox.js";

export const HANDOFF_METADATA_CUSTOM_TYPE = "pi-sessions.handoff";
export const HANDOFF_BOOTSTRAP_ENV = "PI_SESSIONS_HANDOFF_BOOTSTRAP";
export const HANDOFF_STALE_SESSION_MESSAGE =
  "Session handoff failed: target session already has user input.";

export const HANDOFF_SESSION_METADATA_SCHEMA = Type.Object({
  origin: Type.Literal("handoff"),
  goal: Type.String(),
  nextTask: Type.String(),
  initial_prompt: Type.String(),
});

export const HANDOFF_BOOTSTRAP_SCHEMA = Type.Object({
  sessionId: Type.String(),
  goal: Type.String(),
  nextTask: Type.String(),
  initialPrompt: Type.String(),
});

export type HandoffSessionMetadata = Static<typeof HANDOFF_SESSION_METADATA_SCHEMA>;
export type HandoffBootstrap = Static<typeof HANDOFF_BOOTSTRAP_SCHEMA>;

export function createHandoffSessionMetadata(
  goal: string,
  nextTask: string,
  initialPrompt: string,
): HandoffSessionMetadata {
  const normalizedGoal = goal.trim();
  const normalizedNextTask = nextTask.trim() || normalizedGoal;

  return {
    origin: "handoff",
    goal: normalizedGoal,
    nextTask: normalizedNextTask,
    initial_prompt: initialPrompt.trim(),
  };
}

export function createHandoffBootstrap(
  sessionId: string,
  metadata: HandoffSessionMetadata,
): HandoffBootstrap {
  return {
    sessionId,
    goal: metadata.goal,
    nextTask: metadata.nextTask,
    initialPrompt: metadata.initial_prompt,
  };
}

export function encodeHandoffBootstrap(bootstrap: HandoffBootstrap): string {
  return Buffer.from(JSON.stringify(bootstrap), "utf8").toString("base64");
}

export function parseHandoffBootstrap(value: string): HandoffBootstrap | undefined {
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return safeParseTypeBoxValue(HANDOFF_BOOTSTRAP_SCHEMA, JSON.parse(decoded));
  } catch {
    return undefined;
  }
}

export function parseHandoffSessionMetadata(value: unknown): HandoffSessionMetadata | undefined {
  return safeParseTypeBoxValue(HANDOFF_SESSION_METADATA_SCHEMA, value);
}

export function getHandoffMetadataFromEntries(
  entries: readonly SessionEntry[],
): HandoffSessionMetadata | undefined {
  for (const entry of entries) {
    if (entry.type !== "custom") {
      continue;
    }

    const metadata = parseCustomHandoffMetadata(entry);
    if (metadata) {
      return metadata;
    }
  }

  return undefined;
}

export function hasUserMessages(entries: readonly SessionEntry[]): boolean {
  return entries.some((entry) => entry.type === "message" && entry.message.role === "user");
}

function parseCustomHandoffMetadata(entry: CustomEntry): HandoffSessionMetadata | undefined {
  if (entry.customType !== HANDOFF_METADATA_CUSTOM_TYPE) {
    return undefined;
  }

  return parseHandoffSessionMetadata(entry.data);
}
