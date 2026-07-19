import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";
import {
  buildHandoffKickoffSource,
  HANDOFF_KICKOFF_CUSTOM_TYPE,
  HANDOFF_KICKOFF_DETAILS_SCHEMA,
  HANDOFF_KICKOFF_SOURCE_SCHEMA,
  type HandoffKickoffSource,
} from "./kickoff.ts";

export const HANDOFF_METADATA_CUSTOM_TYPE = "pi-sessions.handoff";
export const HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE = "pi-sessions.handoff-bootstrap";
export const HANDOFF_BOOTSTRAP_CONSUMED_CUSTOM_TYPE = "pi-sessions.handoff-bootstrap-consumed";
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
  source: HANDOFF_KICKOFF_SOURCE_SCHEMA,
});

export const CHILD_GENERATED_HANDOFF_BOOTSTRAP_SCHEMA = Type.Object({
  mode: Type.Literal("generate"),
  sessionId: Type.String(),
  goal: Type.String(),
  title: Type.String(),
  parentSessionFile: Type.String(),
  sourceLeafId: Type.String(),
  requestResponse: Type.Optional(Type.Boolean()),
  bootstrapMode: Type.Union([Type.Literal("review"), Type.Literal("automatic")]),
});

export const HANDOFF_BOOTSTRAP_SCHEMA = Type.Union([
  IMMEDIATE_HANDOFF_BOOTSTRAP_SCHEMA,
  CHILD_GENERATED_HANDOFF_BOOTSTRAP_SCHEMA,
]);

export const HANDOFF_BOOTSTRAP_CONSUMED_SCHEMA = Type.Object({
  bootstrapEntryId: Type.String(),
  reason: Type.Union([
    Type.Literal("cancelled"),
    Type.Literal("prefilled"),
    Type.Literal("stale"),
    Type.Literal("invalid"),
  ]),
});

export type HandoffSessionMetadata = Static<typeof HANDOFF_SESSION_METADATA_SCHEMA>;
export type ImmediateHandoffBootstrap = Static<typeof IMMEDIATE_HANDOFF_BOOTSTRAP_SCHEMA>;
export type ChildGeneratedHandoffBootstrap = Static<
  typeof CHILD_GENERATED_HANDOFF_BOOTSTRAP_SCHEMA
>;
export type HandoffBootstrap = Static<typeof HANDOFF_BOOTSTRAP_SCHEMA>;
export type HandoffBootstrapConsumed = Static<typeof HANDOFF_BOOTSTRAP_CONSUMED_SCHEMA>;
export type HandoffBootstrapConsumedReason = HandoffBootstrapConsumed["reason"];

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
  source: HandoffKickoffSource,
): ImmediateHandoffBootstrap {
  return {
    sessionId,
    goal: metadata.goal,
    nextTask: metadata.nextTask,
    title: metadata.title,
    initialPrompt: metadata.initial_prompt,
    source: buildHandoffKickoffSource(source),
  };
}

export function createChildGeneratedHandoffBootstrap(options: {
  sessionId: string;
  goal: string;
  title: string;
  parentSessionFile: string;
  sourceLeafId: string;
  requestResponse?: boolean | undefined;
  bootstrapMode?: "review" | "automatic" | undefined;
}): ChildGeneratedHandoffBootstrap {
  return {
    mode: "generate",
    sessionId: options.sessionId,
    goal: options.goal.trim(),
    title: options.title.trim(),
    parentSessionFile: options.parentSessionFile,
    sourceLeafId: options.sourceLeafId,
    ...(options.requestResponse === undefined ? {} : { requestResponse: options.requestResponse }),
    bootstrapMode: options.bootstrapMode ?? "review",
  };
}

export function isChildGeneratedHandoffBootstrap(
  bootstrap: HandoffBootstrap,
): bootstrap is ChildGeneratedHandoffBootstrap {
  return "mode" in bootstrap && bootstrap.mode === "generate";
}

export type PendingHandoffBootstrapScan =
  | { kind: "pending"; entryId: string; bootstrap: HandoffBootstrap }
  | { kind: "invalid"; entryId: string };

/**
 * Finds the newest unconsumed pending bootstrap on a branch. Consumption is
 * append-only: a delivered kickoff or consumed marker must reference the
 * bootstrap entry it consumed.
 */
export function findPendingHandoffBootstrap(
  branch: readonly SessionEntry[],
): PendingHandoffBootstrapScan | undefined {
  const consumedEntryIds = new Set<string>();
  for (const entry of branch) {
    if (entry.type === "custom_message" && entry.customType === HANDOFF_KICKOFF_CUSTOM_TYPE) {
      const details = safeParseTypeBoxValue(HANDOFF_KICKOFF_DETAILS_SCHEMA, entry.details);
      if (details?.bootstrapEntryId) {
        consumedEntryIds.add(details.bootstrapEntryId);
      }
    }
    if (entry.type === "custom" && entry.customType === HANDOFF_BOOTSTRAP_CONSUMED_CUSTOM_TYPE) {
      const consumed = safeParseTypeBoxValue(HANDOFF_BOOTSTRAP_CONSUMED_SCHEMA, entry.data);
      if (consumed) {
        consumedEntryIds.add(consumed.bootstrapEntryId);
      }
    }
  }

  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (
      entry?.type !== "custom" ||
      entry.customType !== HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE ||
      consumedEntryIds.has(entry.id)
    ) {
      continue;
    }

    const bootstrap = safeParseTypeBoxValue(HANDOFF_BOOTSTRAP_SCHEMA, entry.data);
    return bootstrap
      ? { kind: "pending", entryId: entry.id, bootstrap }
      : { kind: "invalid", entryId: entry.id };
  }

  return undefined;
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

// Bootstrap freshness: an existing kickoff counts as a started conversation
// even though no native user message exists.
export function hasStartedConversation(entries: readonly SessionEntry[]): boolean {
  return entries.some(
    (entry) =>
      (entry.type === "message" && entry.message.role === "user") ||
      (entry.type === "custom_message" && entry.customType === HANDOFF_KICKOFF_CUSTOM_TYPE),
  );
}

function parseCustomHandoffMetadata(entry: CustomEntry): HandoffSessionMetadata | undefined {
  if (entry.customType !== HANDOFF_METADATA_CUSTOM_TYPE) {
    return undefined;
  }

  return parseHandoffSessionMetadata(entry.data);
}
