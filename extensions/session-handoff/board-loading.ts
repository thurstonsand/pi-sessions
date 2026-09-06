import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SubagentRoster } from "../subagents/roster.ts";
import type { HandoffBoardSnapshot, UserSessionEntry } from "./board-view-model.ts";
import { HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE } from "./metadata.ts";
import { parseHandoffLaunchReceiptEntry } from "./receipt.ts";

export interface HandoffBoardServices {
  roster?: SubagentRoster | undefined;
  cancelSubagent?: ((sessionId: string) => Promise<unknown>) | undefined;
  listLiveSessions?: (() => Promise<string[]>) | undefined;
  readSessionEntries?: ((sessionFile: string) => readonly SessionEntry[]) | undefined;
}

export async function loadHandoffBoardSnapshot(
  entries: readonly SessionEntry[],
  services: HandoffBoardServices,
): Promise<HandoffBoardSnapshot> {
  const userSessions = collectUserSessions(entries);
  const [branchRoster, liveSessionIds, hydratedUserSessions] = await Promise.all([
    services.roster?.resolve("branch") ?? Promise.resolve({ entries: [], total: 0 }),
    services.listLiveSessions?.() ?? Promise.resolve([]),
    Promise.all(
      userSessions.map(
        async (entry): Promise<UserSessionEntry> => ({
          ...entry,
          runEvidence: loadUserSessionRunEvidence(entry, services),
        }),
      ),
    ),
  ]);
  return {
    subagents: branchRoster.entries,
    userSessions: hydratedUserSessions,
    liveSessionIds: new Set(liveSessionIds),
    hasLiveSessionEvidence: services.listLiveSessions !== undefined,
  };
}

export function collectUserSessions(entries: readonly SessionEntry[]): UserSessionEntry[] {
  const bySessionId = new Map<string, UserSessionEntry>();
  for (const entry of entries) {
    const receipt = parseHandoffLaunchReceiptEntry(entry);
    if (!receipt || receipt.launch === "subagent") {
      continue;
    }
    const candidate = {
      sessionId: receipt.sessionId,
      timestamp: entry.timestamp,
      receipt,
    };
    const existing = bySessionId.get(candidate.sessionId);
    if (!existing || candidate.timestamp > existing.timestamp) {
      bySessionId.set(candidate.sessionId, candidate);
    }
  }
  return [...bySessionId.values()].sort((left, right) =>
    right.timestamp.localeCompare(left.timestamp),
  );
}

function loadUserSessionRunEvidence(
  entry: UserSessionEntry,
  services: HandoffBoardServices,
): NonNullable<UserSessionEntry["runEvidence"]> {
  if (!services.readSessionEntries) {
    return unavailableRunEvidence();
  }

  try {
    return {
      transcriptAvailable: true,
      hasStarted: services
        .readSessionEntries(entry.receipt.childSessionFile)
        .some(isSessionStartupEvidence),
    };
  } catch {
    return unavailableRunEvidence();
  }
}

function unavailableRunEvidence(): NonNullable<UserSessionEntry["runEvidence"]> {
  return { transcriptAvailable: false, hasStarted: false };
}

function isSessionStartupEvidence(entry: SessionEntry): boolean {
  if (entry.type === "session_info") {
    return false;
  }
  if (entry.type !== "custom") {
    return true;
  }
  return entry.customType !== HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE;
}
