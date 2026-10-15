import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { isSessionStarting } from "../session-handoff/metadata.ts";
import { formatError } from "../shared/errors.ts";
import {
  getSessionById,
  type SessionLineageRow,
  withSessionIndex,
} from "../shared/session-index/index.ts";
import type {
  ReachableSubagent,
  ReachableUserSession,
  SessionReachableScope,
} from "./pi/reachable-contract.ts";

/** The subagent facts the directory needs; the roster satisfies it structurally. */
export interface ReachableSubagentEntry {
  sessionId: string;
  title: string;
  goal: string;
  cwd: string;
  state: string;
  depth: number;
  onActiveBranch: boolean;
  launchedAt: string;
  model?: string | undefined;
  ownerSessionId: string;
  ownerTitle: string;
  ownerIsCurrentSession: boolean;
  resumeCommand: string;
}

export interface SessionReachableDeps {
  indexPath: string;
  listSessions(): Promise<string[]>;
  getRelationTo(sessionId: string): string | undefined;
  listSubagents?:
    | ((
        scope: Exclude<SessionReachableScope, "user">,
      ) => Promise<readonly ReachableSubagentEntry[]>)
    | undefined;
  getParentSessionId?: (() => string | undefined) | undefined;
}

export async function listReachableUserSessions(
  deps: SessionReachableDeps,
  ctx: ExtensionContext,
): Promise<ReachableUserSession[]> {
  const currentSessionId = ctx.sessionManager.getSessionId();
  let liveSessionIds: string[];
  try {
    liveSessionIds = await deps.listSessions();
  } catch (error) {
    throw new Error(`Session messaging is unavailable: ${formatError(error)}`);
  }
  const parentSessionId = deps.getParentSessionId?.();
  const targetIds = [...new Set(liveSessionIds)].filter(
    (sessionId) => sessionId !== currentSessionId && sessionId !== parentSessionId,
  );
  return withSessionIndex(deps.indexPath, { mode: "read", required: true }, ({ db }) => {
    const sessions: ReachableUserSession[] = [];
    for (const sessionId of targetIds) {
      const row = getSessionById(db, sessionId);
      if (row?.sessionOrigin === "subagent") continue;
      const relation = deps.getRelationTo(sessionId);
      sessions.push({
        kind: "user",
        sessionId,
        state: row && isStartingSession(row) ? "starting" : "live",
        ...(row?.sessionName ? { title: row.sessionName } : {}),
        ...(row?.cwd ? { cwd: row.cwd } : {}),
        ...(row?.modifiedAt ? { modifiedAt: row.modifiedAt } : {}),
        ...(relation === undefined ? {} : { relation }),
      });
    }
    return sessions.sort((left, right) =>
      (right.modifiedAt ?? "").localeCompare(left.modifiedAt ?? ""),
    );
  });
}

export async function listReachableSubagents(
  deps: SessionReachableDeps,
  scope: Exclude<SessionReachableScope, "user">,
): Promise<ReachableSubagent[]> {
  if (!deps.listSubagents) throw new Error("Subagent roster is unavailable.");
  try {
    const entries = await deps.listSubagents(scope);
    return entries.map((entry) => ({
      kind: "subagent",
      sessionId: entry.sessionId,
      title: entry.title,
      goal: entry.goal,
      cwd: entry.cwd,
      state: entry.state,
      depth: entry.depth,
      onActiveBranch: entry.onActiveBranch,
      launchedAt: entry.launchedAt,
      ...(entry.model === undefined ? {} : { model: entry.model }),
      ownerSessionId: entry.ownerSessionId,
      ownerTitle: entry.ownerTitle,
      ownerIsCurrentSession: entry.ownerIsCurrentSession,
      resumeCommand: entry.resumeCommand,
    }));
  } catch (error) {
    throw new Error(`Subagent roster is unavailable: ${formatError(error)}`);
  }
}

function isStartingSession(row: SessionLineageRow): boolean {
  try {
    return isSessionStarting(SessionManager.open(row.sessionPath).getBranch());
  } catch {
    return false;
  }
}
