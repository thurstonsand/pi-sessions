import path from "node:path";
import { formatSessionTitleOrShortId } from "../../shared/session-ui.ts";
import { normalizeOptionalText } from "../../shared/text.ts";
import type { ListedSession, SessionListScope, SessionListToolDetails } from "./list-contract.ts";

export interface SessionListRowViewModel {
  label: string;
  sessionId: string;
  annotations: string[];
  location?: string | undefined;
  detail?: string | undefined;
}

export interface SessionListViewModel {
  scope: SessionListScope;
  rows: SessionListRowViewModel[];
}

export function buildSessionListView(details: SessionListToolDetails): SessionListViewModel {
  return {
    scope: details.scope,
    rows: details.sessions.map(buildSessionListRow),
  };
}

function buildSessionListRow(session: ListedSession): SessionListRowViewModel {
  if (session.kind === "user") {
    return {
      label: formatSessionTitleOrShortId(session.title, session.session_id),
      sessionId: session.session_id,
      annotations: [session.state, ...(session.relation ? [session.relation] : [])],
      location: formatLocation(session.cwd),
    };
  }

  return {
    label: formatSessionTitleOrShortId(session.title, session.session_id),
    sessionId: session.session_id,
    annotations: [
      session.state,
      `depth ${session.depth}`,
      ...(session.on_active_branch ? [] : ["history"]),
      ...(session.owner_is_current_session ? [] : [`owner ${session.owner_title}`]),
    ],
    location: formatLocation(session.cwd),
    detail: normalizeOptionalText(session.briefing),
  };
}

function formatLocation(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  return path.basename(cwd) || cwd;
}
