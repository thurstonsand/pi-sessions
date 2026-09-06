import {
  defineTool,
  type ExtensionContext,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isSessionStarting } from "../../session-handoff/metadata.ts";
import { formatError } from "../../shared/errors.ts";
import { ExpandableContentLayout } from "../../shared/rendering/expandable-content-layout.ts";
import {
  getSessionById,
  type SessionLineageRow,
  withSessionIndex,
} from "../../shared/session-index/index.ts";
import { safeParseTypeBoxValue } from "../../shared/typebox.ts";
import {
  type ReachableSubagent,
  type ReachableUserSession,
  SESSION_REACHABLE_PARAMS,
  SESSION_REACHABLE_TOOL_DETAILS_SCHEMA,
  SESSION_REACHABLE_USER_PARAMS,
  type SessionReachableParams,
  type SessionReachableScope,
  type SessionReachableToolDetails,
} from "./reachable-contract.ts";
import { buildSessionReachablePresentation } from "./reachable-presenter.ts";
import { buildSessionReachableView } from "./reachable-view-model.ts";

/** The subagent facts this tool needs; the roster satisfies it structurally. */
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
  /** Resolved per call; the parent is unreachable from a subagent, so it stays off the menu. */
  getParentSessionId?: (() => string | undefined) | undefined;
}

interface SessionReachableRendererState {
  layout?: ExpandableContentLayout | undefined;
}

export function createSessionReachableTool(deps: SessionReachableDeps): ToolDefinition {
  const subagentsAvailable = Boolean(deps.listSubagents);

  return defineTool({
    name: "session_reachable",
    label: "Reachable Sessions",
    description: subagentsAvailable
      ? "List the sessions this session can address: live user sessions, or its own subagents."
      : "List the live user sessions this session can address.",
    promptSnippet: subagentsAvailable
      ? "List addressable live sessions and owned subagents"
      : "List addressable live sessions",
    promptGuidelines: [
      "Before session_send_message, use session_reachable to find the target session id.",
    ],
    parameters: subagentsAvailable ? SESSION_REACHABLE_PARAMS : SESSION_REACHABLE_USER_PARAMS,
    renderResult(result, options, theme, context) {
      const output = result.content.find((item) => item.type === "text")?.text ?? "";
      if (context.isError) {
        return new Text(output ? theme.fg("error", output) : "", 0, 0);
      }

      const details = safeParseTypeBoxValue(SESSION_REACHABLE_TOOL_DETAILS_SCHEMA, result.details);
      if (!details) {
        return new Text(output, 0, 0);
      }

      const state = context.state as SessionReachableRendererState;
      const layout = state.layout ?? new ExpandableContentLayout(theme);
      state.layout = layout;
      layout.update(
        buildSessionReachablePresentation(buildSessionReachableView(details), theme),
        options.expanded,
      );
      return layout;
    },
    async execute(_toolCallId, params: SessionReachableParams, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? "user";
      const sessions =
        scope === "user"
          ? await listReachableUserSessions(deps, ctx)
          : await listReachableSubagents(deps, scope);

      const details: SessionReachableToolDetails = { scope, sessions };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
}

async function listReachableUserSessions(
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
  const targetIds = liveSessionIds.filter(
    (sessionId) => sessionId !== currentSessionId && sessionId !== parentSessionId,
  );
  return withSessionIndex(deps.indexPath, { mode: "read", required: true }, ({ db }) => {
    const sessions: ReachableUserSession[] = [];
    for (const sessionId of targetIds) {
      const row = getSessionById(db, sessionId);
      if (row?.sessionOrigin === "subagent") {
        continue;
      }
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
    return sessions.sort(compareByModifiedDesc);
  });
}

async function listReachableSubagents(
  deps: SessionReachableDeps,
  scope: Exclude<SessionReachableScope, "user">,
): Promise<ReachableSubagent[]> {
  if (!deps.listSubagents) {
    throw new Error(`session_reachable scope "${scope}" requires subagents to be active.`);
  }

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

function compareByModifiedDesc(left: ReachableUserSession, right: ReachableUserSession): number {
  return (right.modifiedAt ?? "").localeCompare(left.modifiedAt ?? "");
}
