import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";
import { HANDOFF_KICKOFF_CUSTOM_TYPE, HANDOFF_KICKOFF_DETAILS_SCHEMA } from "./kickoff.ts";
import {
  HANDOFF_LAUNCH_VALUE_SCHEMA,
  HANDOFF_NON_SUBAGENT_LAUNCH_SCHEMA,
  type HandoffLaunchValue,
  SUBAGENT_LAUNCH,
} from "./launch-target.ts";

export const HANDOFF_METADATA_CUSTOM_TYPE = "pi-sessions.handoff";
export const HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE = "pi-sessions.handoff-bootstrap";
export const HANDOFF_BOOTSTRAP_CONSUMED_CUSTOM_TYPE = "pi-sessions.handoff-bootstrap-consumed";
export const HANDOFF_BOOTSTRAP_FAILED_CUSTOM_TYPE = "pi-sessions.handoff-bootstrap-failed";
export const HANDOFF_STALE_SESSION_MESSAGE =
  "Session handoff failed: target session already has user input.";
export const SESSION_STARTING_MESSAGE =
  "Target session is still starting. wait for session_reachable to report it as live, then resend.";

// A subagent's self-knowledge, stamped into its child-local bootstrap so the
// child never opens the parent transcript to learn who it is.
export const HANDOFF_SUBAGENT_SCHEMA = Type.Object({
  childSessionId: Type.String(),
  ownerSessionId: Type.String(),
  depth: Type.Integer({ minimum: 1 }),
  requestResponse: Type.Boolean(),
});

const HANDOFF_METADATA_BASE = {
  origin: Type.Literal("handoff"),
  goal: Type.String(),
  title: Type.String(),
  initial_prompt: Type.String(),
};

export const HANDOFF_SESSION_METADATA_SCHEMA = Type.Object({
  ...HANDOFF_METADATA_BASE,
  launch: HANDOFF_LAUNCH_VALUE_SCHEMA,
});

const HANDOFF_BOOTSTRAP_BASE = {
  mode: Type.Literal("generate"),
  sessionId: Type.String(),
  goal: Type.String(),
  title: Type.String(),
  parentSessionFile: Type.String(),
  sourceLeafId: Type.String(),
  requestResponse: Type.Boolean(),
  bootstrapMode: Type.Union([Type.Literal("review"), Type.Literal("automatic")]),
};

export const HANDOFF_BOOTSTRAP_SCHEMA = Type.Union([
  Type.Object({
    ...HANDOFF_BOOTSTRAP_BASE,
    launch: Type.Literal(SUBAGENT_LAUNCH),
    subagent: HANDOFF_SUBAGENT_SCHEMA,
  }),
  Type.Object({
    ...HANDOFF_BOOTSTRAP_BASE,
    launch: HANDOFF_NON_SUBAGENT_LAUNCH_SCHEMA,
    subagent: Type.Optional(Type.Never()),
  }),
]);

// A bootstrap whose generation failed stays pending so a resume can retry it,
// but the failure is recorded so the session stops reading as one that is
// still starting.
export const HANDOFF_BOOTSTRAP_FAILED_SCHEMA = Type.Object({
  bootstrapEntryId: Type.String(),
  error: Type.String(),
});

export const HANDOFF_BOOTSTRAP_CONSUMED_SCHEMA = Type.Object({
  bootstrapEntryId: Type.String(),
  reason: Type.Union([
    Type.Literal("cancelled"),
    Type.Literal("prefilled"),
    Type.Literal("stale"),
    Type.Literal("invalid"),
  ]),
});

export type HandoffSubagent = Static<typeof HANDOFF_SUBAGENT_SCHEMA>;
export type HandoffSessionMetadata = Static<typeof HANDOFF_SESSION_METADATA_SCHEMA>;
export type HandoffBootstrap = Static<typeof HANDOFF_BOOTSTRAP_SCHEMA>;
export type ChildGeneratedHandoffBootstrap = HandoffBootstrap;
export type HandoffBootstrapConsumed = Static<typeof HANDOFF_BOOTSTRAP_CONSUMED_SCHEMA>;
export type HandoffBootstrapFailed = Static<typeof HANDOFF_BOOTSTRAP_FAILED_SCHEMA>;
export type HandoffBootstrapConsumedReason = HandoffBootstrapConsumed["reason"];

export function createHandoffSessionMetadata(
  goal: string,
  initialPrompt: string,
  title: string,
  launch: HandoffLaunchValue,
): HandoffSessionMetadata {
  return {
    origin: "handoff",
    goal: goal.trim(),
    title,
    initial_prompt: initialPrompt.trim(),
    launch,
  };
}

export function createChildGeneratedHandoffBootstrap(options: {
  sessionId: string;
  goal: string;
  title: string;
  parentSessionFile: string;
  sourceLeafId: string;
  requestResponse: boolean;
  bootstrapMode: "review" | "automatic";
  launch: HandoffLaunchValue;
  subagent?: HandoffSubagent | undefined;
}): ChildGeneratedHandoffBootstrap {
  const base = {
    mode: "generate" as const,
    sessionId: options.sessionId,
    goal: options.goal.trim(),
    title: options.title.trim(),
    parentSessionFile: options.parentSessionFile,
    sourceLeafId: options.sourceLeafId,
    requestResponse: options.requestResponse,
    bootstrapMode: options.bootstrapMode,
  };
  if (options.launch === SUBAGENT_LAUNCH) {
    if (!options.subagent) {
      throw new Error("A subagent handoff requires a subagent identity block.");
    }
    return { ...base, launch: options.launch, subagent: options.subagent };
  }
  return { ...base, launch: options.launch };
}

export type PendingHandoffBootstrapScan =
  | { kind: "pending"; entryId: string; bootstrap: HandoffBootstrap; failure?: string | undefined }
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
  const failuresByEntryId = new Map<string, string>();
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
    if (entry.type === "custom" && entry.customType === HANDOFF_BOOTSTRAP_FAILED_CUSTOM_TYPE) {
      const failed = safeParseTypeBoxValue(HANDOFF_BOOTSTRAP_FAILED_SCHEMA, entry.data);
      if (failed) {
        failuresByEntryId.set(failed.bootstrapEntryId, failed.error);
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
    if (!bootstrap) {
      return { kind: "invalid", entryId: entry.id };
    }
    const failure = failuresByEntryId.get(entry.id);
    return { kind: "pending", entryId: entry.id, bootstrap, ...(failure ? { failure } : {}) };
  }

  return undefined;
}

/**
 * A session is *starting* when its active branch still carries an unconsumed,
 * well-formed handoff bootstrap: it has been prepared but has not received its
 * kickoff. An invalid bootstrap does not count — the child consumes it and
 * proceeds as an ordinary session rather than kicking off a handoff. Neither
 * does one whose generation already failed: it stays retryable on resume, but
 * nothing is starting right now.
 */
export function isSessionStarting(branch: readonly SessionEntry[]): boolean {
  const scan = findPendingHandoffBootstrap(branch);
  return scan?.kind === "pending" && scan.failure === undefined;
}

/**
 * Folds the bootstrap lifecycle in one transcript pass. The bootstrap owns its
 * data; kickoff and consumed entries only establish whether it started or ended.
 */
export function findCurrentHandoffBootstrap(
  branch: readonly SessionEntry[],
): HandoffBootstrap | undefined {
  const bootstrapsById = new Map<string, HandoffBootstrap>();
  const bootstrapIds: string[] = [];
  const startedBootstrapIds: string[] = [];
  const endedBootstrapIds = new Set<string>();
  let conversationStarted = false;

  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "user") {
      conversationStarted = true;
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === HANDOFF_KICKOFF_CUSTOM_TYPE) {
      conversationStarted = true;
      const details = safeParseTypeBoxValue(HANDOFF_KICKOFF_DETAILS_SCHEMA, entry.details);
      if (details?.bootstrapEntryId) {
        startedBootstrapIds.push(details.bootstrapEntryId);
      }
      continue;
    }
    if (entry.type !== "custom") {
      continue;
    }
    if (entry.customType === HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE) {
      const bootstrap = safeParseTypeBoxValue(HANDOFF_BOOTSTRAP_SCHEMA, entry.data);
      if (bootstrap) {
        bootstrapsById.set(entry.id, bootstrap);
        bootstrapIds.push(entry.id);
      }
      continue;
    }
    if (entry.customType === HANDOFF_BOOTSTRAP_CONSUMED_CUSTOM_TYPE) {
      const consumed = safeParseTypeBoxValue(HANDOFF_BOOTSTRAP_CONSUMED_SCHEMA, entry.data);
      if (consumed) {
        endedBootstrapIds.add(consumed.bootstrapEntryId);
      }
    }
  }

  for (let index = startedBootstrapIds.length - 1; index >= 0; index -= 1) {
    const bootstrap = bootstrapsById.get(startedBootstrapIds[index] ?? "");
    if (bootstrap) {
      return bootstrap;
    }
  }
  if (conversationStarted) {
    return undefined;
  }
  for (let index = bootstrapIds.length - 1; index >= 0; index -= 1) {
    const bootstrapId = bootstrapIds[index];
    if (bootstrapId && !endedBootstrapIds.has(bootstrapId)) {
      return bootstrapsById.get(bootstrapId);
    }
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
