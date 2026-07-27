import path from "node:path";
import { formatSessionTitleOrShortId } from "../../shared/session-ui.ts";
import { normalizeOptionalText } from "../../shared/text.ts";
import type {
  ReachableSession,
  SessionReachableScope,
  SessionReachableToolDetails,
} from "./reachable-contract.ts";

export interface ReachableSessionRowViewModel {
  label: string;
  sessionId: string;
  annotations: string[];
  location?: string | undefined;
  detail?: string | undefined;
}

export interface SessionReachableViewModel {
  scope: SessionReachableScope;
  rows: ReachableSessionRowViewModel[];
}

export function buildSessionReachableView(
  details: SessionReachableToolDetails,
): SessionReachableViewModel {
  return {
    scope: details.scope,
    rows: details.sessions.map(buildReachableSessionRow),
  };
}

function buildReachableSessionRow(session: ReachableSession): ReachableSessionRowViewModel {
  if (session.kind === "user") {
    return {
      label: formatSessionTitleOrShortId(session.title, session.sessionId),
      sessionId: session.sessionId,
      annotations: [session.state, ...(session.relation ? [session.relation] : [])],
      location: formatLocation(session.cwd),
    };
  }

  return {
    label: formatSessionTitleOrShortId(session.title, session.sessionId),
    sessionId: session.sessionId,
    annotations: [
      session.state,
      `depth ${session.depth}`,
      ...(session.onActiveBranch ? [] : ["history"]),
      ...(session.ownerIsCurrentSession ? [] : [`owner ${session.ownerTitle}`]),
    ],
    location: formatLocation(session.cwd),
    detail: normalizeOptionalText(session.goal),
  };
}

function formatLocation(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  return path.basename(cwd) || cwd;
}
