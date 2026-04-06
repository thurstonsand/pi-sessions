import { randomUUID } from "node:crypto";
import type { CustomEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { safeParseTypeBoxValue } from "../shared/typebox.js";

export const HANDOFF_METADATA_CUSTOM_TYPE = "pi-sessions.handoff";
export const PENDING_SEND_CONSUMED_CUSTOM_TYPE = "pi-sessions.pending-send-consumed";

export const HANDOFF_SESSION_METADATA_SCHEMA = Type.Object({
  origin: Type.Literal("handoff"),
  goal: Type.String(),
  nextTask: Type.String(),
  initial_prompt: Type.String(),
  initial_prompt_nonce: Type.String(),
});

export const PENDING_SEND_CONSUMED_ENTRY_SCHEMA = Type.Object({
  nonce: Type.String(),
});

export type HandoffSessionMetadata = Static<typeof HANDOFF_SESSION_METADATA_SCHEMA>;
export type PendingSendConsumedEntryData = Static<typeof PENDING_SEND_CONSUMED_ENTRY_SCHEMA>;

export function createHandoffSessionMetadata(
  goal: string,
  nextTask: string,
  initialPrompt: string,
): HandoffSessionMetadata {
  const normalizedGoal = goal.trim();
  const normalizedNextTask = nextTask.trim() || normalizedGoal;
  const normalizedInitialPrompt = initialPrompt.trim();

  return {
    origin: "handoff",
    goal: normalizedGoal,
    nextTask: normalizedNextTask,
    initial_prompt: normalizedInitialPrompt,
    initial_prompt_nonce: randomUUID(),
  };
}

export function createPendingSendConsumedEntry(nonce: string): PendingSendConsumedEntryData {
  return { nonce };
}

export function parsePendingSendConsumedEntry(
  value: unknown,
): PendingSendConsumedEntryData | undefined {
  return safeParseTypeBoxValue(PENDING_SEND_CONSUMED_ENTRY_SCHEMA, value);
}

export function parseHandoffSessionMetadata(value: unknown): HandoffSessionMetadata | undefined {
  return safeParseTypeBoxValue(HANDOFF_SESSION_METADATA_SCHEMA, value);
}

export function getPendingInitialPromptFromEntries(
  entries: readonly SessionEntry[],
): HandoffSessionMetadata | undefined {
  const consumed = new Set<string>();
  let pending: HandoffSessionMetadata | undefined;

  for (const entry of entries) {
    if (entry.type !== "custom") {
      continue;
    }

    const customEntry = entry as CustomEntry;
    if (customEntry.customType === PENDING_SEND_CONSUMED_CUSTOM_TYPE) {
      const consumedEntry = parsePendingSendConsumedEntry(customEntry.data);
      if (consumedEntry) {
        consumed.add(consumedEntry.nonce);
        if (pending?.initial_prompt_nonce === consumedEntry.nonce) {
          pending = undefined;
        }
      }
      continue;
    }

    if (customEntry.customType !== HANDOFF_METADATA_CUSTOM_TYPE) {
      continue;
    }

    const metadata = parseHandoffSessionMetadata(customEntry.data);
    if (!metadata) {
      continue;
    }

    if (consumed.has(metadata.initial_prompt_nonce)) {
      continue;
    }

    pending = metadata;
  }

  return pending;
}
