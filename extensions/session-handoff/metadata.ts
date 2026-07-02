import { Buffer } from "node:buffer";
import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";

export const HANDOFF_METADATA_CUSTOM_TYPE = "pi-sessions.handoff";
export const HANDOFF_BOOTSTRAP_ENV = "PI_SESSIONS_HANDOFF_BOOTSTRAP";
export const HANDOFF_STALE_SESSION_MESSAGE =
  "Session handoff failed: target session already has user input.";

export const HANDOFF_SESSION_METADATA_SCHEMA = Type.Object({
  origin: Type.Literal("handoff"),
  goal: Type.String(),
  nextTask: Type.String(),
  title: Type.String(),
  initial_prompt: Type.String(),
});

export const IMMEDIATE_HANDOFF_BOOTSTRAP_SCHEMA = Type.Object({
  sessionId: Type.String(),
  goal: Type.String(),
  nextTask: Type.String(),
  title: Type.String(),
  initialPrompt: Type.String(),
});

export const CHILD_GENERATED_HANDOFF_BOOTSTRAP_SCHEMA = Type.Object({
  mode: Type.Literal("generate"),
  sessionId: Type.String(),
  goal: Type.String(),
  title: Type.String(),
  parentSessionFile: Type.String(),
  requestResponse: Type.Optional(Type.Boolean()),
});

export const HANDOFF_BOOTSTRAP_SCHEMA = Type.Union([
  IMMEDIATE_HANDOFF_BOOTSTRAP_SCHEMA,
  CHILD_GENERATED_HANDOFF_BOOTSTRAP_SCHEMA,
]);

export type HandoffSessionMetadata = Static<typeof HANDOFF_SESSION_METADATA_SCHEMA>;
export type ImmediateHandoffBootstrap = Static<typeof IMMEDIATE_HANDOFF_BOOTSTRAP_SCHEMA>;
export type ChildGeneratedHandoffBootstrap = Static<
  typeof CHILD_GENERATED_HANDOFF_BOOTSTRAP_SCHEMA
>;
export type HandoffBootstrap = Static<typeof HANDOFF_BOOTSTRAP_SCHEMA>;

export function createHandoffSessionMetadata(
  goal: string,
  nextTask: string,
  initialPrompt: string,
  title: string,
): HandoffSessionMetadata {
  const normalizedGoal = goal.trim();
  const normalizedNextTask = nextTask.trim() || normalizedGoal;

  return {
    origin: "handoff",
    goal: normalizedGoal,
    nextTask: normalizedNextTask,
    title,
    initial_prompt: initialPrompt.trim(),
  };
}

export function createHandoffBootstrap(
  sessionId: string,
  metadata: HandoffSessionMetadata,
): ImmediateHandoffBootstrap {
  return {
    sessionId,
    goal: metadata.goal,
    nextTask: metadata.nextTask,
    title: metadata.title,
    initialPrompt: metadata.initial_prompt,
  };
}

export function createChildGeneratedHandoffBootstrap(options: {
  sessionId: string;
  goal: string;
  title: string;
  parentSessionFile: string;
  requestResponse?: boolean | undefined;
}): ChildGeneratedHandoffBootstrap {
  return {
    mode: "generate",
    sessionId: options.sessionId,
    goal: options.goal.trim(),
    title: options.title.trim(),
    parentSessionFile: options.parentSessionFile,
    ...(options.requestResponse === undefined ? {} : { requestResponse: options.requestResponse }),
  };
}

export function isChildGeneratedHandoffBootstrap(
  bootstrap: HandoffBootstrap,
): bootstrap is ChildGeneratedHandoffBootstrap {
  return "mode" in bootstrap && bootstrap.mode === "generate";
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
