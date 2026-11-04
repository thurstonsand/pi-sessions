import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { isSessionStarting } from "../session-handoff/metadata.ts";
import { formatError } from "../shared/errors.ts";
import {
  getSessionById,
  type SessionLineageRow,
  withSessionIndex,
} from "../shared/session-index/index.ts";
import type { ListedSubagent, ListedUserSession, SessionListScope } from "./pi/list-contract.ts";

/** The subagent facts the directory needs; the roster satisfies it structurally. */
export interface SubagentListEntry {
  sessionId: string;
  title: string;
  briefing: string;
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

export interface SessionListDeps {
  indexPath: string;
  listSessions(): Promise<string[]>;
  getRelationTo(sessionId: string): string | undefined;
  listSubagents?:
    | ((scope: Exclude<SessionListScope, "user">) => Promise<readonly SubagentListEntry[]>)
    | undefined;
  getParentSessionId?: (() => string | undefined) | undefined;
}

export async function listUserSessions(
  deps: SessionListDeps,
  ctx: ExtensionContext,
): Promise<ListedUserSession[]> {
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
    const sessions: ListedUserSession[] = [];
    for (const sessionId of targetIds) {
      const row = getSessionById(db, sessionId);
      if (row?.sessionOrigin === "subagent") continue;
      const relation = deps.getRelationTo(sessionId);
      sessions.push({
        kind: "user",
        session_id: sessionId,
        state: row && isStartingSession(row) ? "starting" : "live",
        ...(row?.sessionName ? { title: row.sessionName } : {}),
        ...(row?.cwd ? { cwd: row.cwd } : {}),
        ...(row?.modifiedAt ? { modified_at: row.modifiedAt } : {}),
        ...(relation === undefined ? {} : { relation }),
      });
    }
    return sessions.sort((left, right) =>
      (right.modified_at ?? "").localeCompare(left.modified_at ?? ""),
    );
  });
}

export async function listSubagentSessions(
  deps: SessionListDeps,
  scope: Exclude<SessionListScope, "user">,
): Promise<ListedSubagent[]> {
  if (!deps.listSubagents) throw new Error("Subagent roster is unavailable.");
  try {
    const entries = await deps.listSubagents(scope);
    return entries.map((entry) => ({
      kind: "subagent",
      session_id: entry.sessionId,
      title: entry.title,
      briefing: entry.briefing,
      cwd: entry.cwd,
      state: entry.state,
      depth: entry.depth,
      on_active_branch: entry.onActiveBranch,
      launched_at: entry.launchedAt,
      ...(entry.model === undefined ? {} : { model: entry.model }),
      owner_session_id: entry.ownerSessionId,
      owner_title: entry.ownerTitle,
      owner_is_current_session: entry.ownerIsCurrentSession,
      resume_command: entry.resumeCommand,
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
