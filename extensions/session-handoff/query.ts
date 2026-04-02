import path from "node:path";
import {
  getIndexStatus,
  getLineageAutocompleteSessions,
  getRecentAutocompleteSessions,
  getSessionByPath,
  INDEX_SCHEMA_VERSION,
  openIndexDatabase,
  type SessionLineageRelation,
  type SessionLineageRow,
  type SessionRelatedSessionRow,
} from "../session-search/db.js";
import { deriveRepoRootForPath } from "../session-search/normalize.js";

const SESSION_TOKEN_PREFIX = "@session:";

export interface HandoffAutocompleteCandidate {
  value: string;
  label: string;
  description?: string | undefined;
  sessionId: string;
  relation?: SessionLineageRelation | undefined;
  distance?: number | undefined;
}

export interface ListHandoffAutocompleteCandidatesOptions {
  currentSessionPath?: string | undefined;
  currentCwd?: string | undefined;
  prefix: string;
  includeAll: boolean;
  indexPath: string;
  limit?: number | undefined;
}

export interface HandoffAutocompleteQueryResult {
  candidates: HandoffAutocompleteCandidate[];
  mode: "default" | "all";
  defaultScopeLabel?: string | undefined;
}

export function listHandoffAutocompleteCandidates(
  options: ListHandoffAutocompleteCandidatesOptions,
): HandoffAutocompleteQueryResult {
  const status = getIndexStatus(options.indexPath);
  if (!status.exists || status.schemaVersion !== INDEX_SCHEMA_VERSION) {
    return { candidates: [], mode: options.includeAll ? "all" : "default" };
  }

  const db = openIndexDatabase(status.dbPath, { create: false });
  try {
    const currentSession = options.currentSessionPath
      ? getSessionByPath(db, options.currentSessionPath)
      : undefined;
    const currentCwd = options.currentCwd ?? currentSession?.cwd;
    const currentRepoRoot = deriveCurrentRepoRoot(currentCwd, currentSession);
    const lineageRows = currentSession
      ? getLineageAutocompleteSessions(db, currentSession.sessionId, options.prefix)
      : [];
    const defaultScopeLabel = currentRepoRoot
      ? "current repo"
      : currentCwd
        ? "current cwd"
        : undefined;
    const recentRows = getRecentAutocompleteSessions(db, options.prefix, undefined, {
      excludeSessionId: currentSession?.sessionId,
    });
    const scopedRows = options.includeAll
      ? recentRows
      : getScopedRecentRows(recentRows, currentRepoRoot, currentCwd);
    const rows = combinePinnedRows(lineageRows, scopedRows);

    return {
      candidates: rows.map((row) =>
        buildHandoffAutocompleteCandidate(row, {
          includeAll: options.includeAll,
          currentCwd,
        }),
      ),
      mode: options.includeAll ? "all" : "default",
      defaultScopeLabel,
    };
  } finally {
    db.close();
  }
}

function buildHandoffAutocompleteCandidate(
  row: SessionLineageRow | SessionRelatedSessionRow,
  options: { includeAll: boolean; currentCwd?: string | undefined },
): HandoffAutocompleteCandidate {
  const relation = getRelation(row);
  const distance = getDistance(row);
  const label = buildCandidateLabel(row, relation, distance, options);
  const description = buildCandidateDescription(row);

  return {
    value: `${SESSION_TOKEN_PREFIX}${row.sessionId}`,
    label,
    description,
    sessionId: row.sessionId,
    relation,
    distance,
  };
}

function buildCandidateLabel(
  row: SessionLineageRow,
  relation: SessionLineageRelation | undefined,
  distance: number | undefined,
  options: { includeAll: boolean; currentCwd?: string | undefined },
): string {
  const parts: string[] = [];
  const firstSegment = buildScopeSegment(row, relation, distance, options);
  if (firstSegment) {
    parts.push(firstSegment);
  }

  const sessionTitle = normalizeDisplayText(row.sessionName);
  if (sessionTitle) {
    parts.push(sessionTitle);
  }

  parts.push(shortSessionId(row.sessionId));
  return parts.join(" - ");
}

function buildCandidateDescription(row: SessionLineageRow): string | undefined {
  const fallback = getCandidateContextText(row);
  if (!fallback) {
    return undefined;
  }

  const sessionTitle = normalizeDisplayText(row.sessionName);
  return fallback === sessionTitle ? undefined : fallback;
}

function formatRelationLabel(
  relation: SessionLineageRelation,
  distance: number | undefined,
): string {
  switch (relation) {
    case "parent":
      return "parent";
    case "child":
      return "child";
    case "sibling":
      return "sibling";
    case "ancestor":
      return distance && distance > 1 ? `ancestor (${distance})` : "ancestor";
    case "descendant":
      return distance && distance > 1 ? `descendant (${distance})` : "descendant";
    case "ancestor_sibling":
      return distance && distance > 1 ? `ancestor sibling (${distance})` : "ancestor sibling";
  }
}

function normalizeDisplayText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function getCandidateContextText(row: SessionLineageRow): string | undefined {
  return (
    normalizeDisplayText(row.handoffNextTask) ??
    normalizeDisplayText(row.handoffGoal) ??
    normalizeDisplayText(row.firstUserPrompt)
  );
}

function buildScopeSegment(
  row: SessionLineageRow,
  relation: SessionLineageRelation | undefined,
  distance: number | undefined,
  options: { includeAll: boolean; currentCwd?: string | undefined },
): string | undefined {
  const relationLabel = relation ? formatRelationLabel(relation, distance) : undefined;
  const locationHint = buildLocationHint(row.cwd);
  if (!options.includeAll) {
    return relationLabel ?? locationHint;
  }

  if (relationLabel && locationHint) {
    return `${relationLabel} (${locationHint})`;
  }

  return relationLabel ?? locationHint;
}

function buildLocationHint(cwd: string): string | undefined {
  const normalizedCwd = normalizeDisplayText(cwd);
  if (!normalizedCwd) {
    return undefined;
  }

  const baseName = path.basename(normalizedCwd);
  return baseName || normalizedCwd;
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function combinePinnedRows(
  pinnedRows: SessionRelatedSessionRow[],
  recentRows: SessionLineageRow[],
): Array<SessionLineageRow | SessionRelatedSessionRow> {
  const combined = new Map<string, SessionLineageRow | SessionRelatedSessionRow>();

  for (const row of pinnedRows) {
    combined.set(row.sessionId, row);
  }

  for (const row of recentRows) {
    if (!combined.has(row.sessionId)) {
      combined.set(row.sessionId, row);
    }
  }

  return [...combined.values()];
}

function getScopedRecentRows(
  rows: SessionLineageRow[],
  currentRepoRoot?: string | undefined,
  currentCwd?: string | undefined,
): SessionLineageRow[] {
  if (currentRepoRoot) {
    return rows.filter((row) => row.repoRoots.includes(currentRepoRoot));
  }

  if (currentCwd) {
    return rows.filter((row) => row.cwd === currentCwd);
  }

  return [];
}

function deriveCurrentRepoRoot(
  currentCwd: string | undefined,
  currentSession: SessionLineageRow | undefined,
): string | undefined {
  if (currentCwd) {
    const cwdRepoRoot = deriveRepoRootForPath(currentCwd);
    if (cwdRepoRoot) {
      return cwdRepoRoot;
    }
  }

  return currentSession?.repoRoots[0];
}

function getRelation(
  row: SessionLineageRow | SessionRelatedSessionRow,
): SessionLineageRelation | undefined {
  return "relation" in row && typeof row.relation === "string" ? row.relation : undefined;
}

function getDistance(row: SessionLineageRow | SessionRelatedSessionRow): number | undefined {
  return "distance" in row && typeof row.distance === "number" ? row.distance : undefined;
}
