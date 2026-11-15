import { type Static, Type } from "typebox";
import { parseTypeBoxRows, parseTypeBoxValue } from "../typebox.ts";
import {
  NULLABLE_STRING_SCHEMA,
  parseRepoRoots,
  SESSION_ORIGIN_SCHEMA,
  type SessionIndexDatabase,
  type SessionLineageRelation,
  type SessionLineageRow,
  type SessionRelatedSessionRow,
} from "./common.ts";

const SESSION_LINEAGE_QUERY_ROW_SCHEMA = Type.Object({
  sessionId: Type.String(),
  sessionPath: Type.String(),
  sessionName: Type.String(),
  firstUserPrompt: NULLABLE_STRING_SCHEMA,
  cwd: Type.String(),
  repoRootsJson: Type.String(),
  modifiedAt: Type.String(),
  parentSessionPath: NULLABLE_STRING_SCHEMA,
  parentSessionId: NULLABLE_STRING_SCHEMA,
  sessionOrigin: Type.Union([SESSION_ORIGIN_SCHEMA, Type.Null()]),
  handoffBriefing: NULLABLE_STRING_SCHEMA,
});

function sessionLineageColumns(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return [
    `${prefix}session_id as sessionId`,
    `${prefix}session_path as sessionPath`,
    `${prefix}session_name as sessionName`,
    `${prefix}first_user_prompt as firstUserPrompt`,
    `${prefix}cwd`,
    `${prefix}repo_roots_json as repoRootsJson`,
    `${prefix}modified_ts as modifiedAt`,
    `${prefix}parent_session_path as parentSessionPath`,
    `${prefix}parent_session_id as parentSessionId`,
    `${prefix}session_origin as sessionOrigin`,
    `${prefix}handoff_briefing as handoffBriefing`,
  ].join(",\n          ");
}

function buildSessionLineageRow(
  row: Static<typeof SESSION_LINEAGE_QUERY_ROW_SCHEMA>,
): SessionLineageRow {
  return {
    sessionId: row.sessionId,
    sessionPath: row.sessionPath,
    sessionName: row.sessionName,
    firstUserPrompt: row.firstUserPrompt ?? undefined,
    cwd: row.cwd,
    repoRoots: parseRepoRoots(row.repoRootsJson),
    modifiedAt: row.modifiedAt,
    parentSessionPath: row.parentSessionPath ?? undefined,
    parentSessionId: row.parentSessionId ?? undefined,
    sessionOrigin: row.sessionOrigin ?? undefined,
    handoffBriefing: row.handoffBriefing ?? undefined,
  };
}

export function getSessionById(
  db: SessionIndexDatabase,
  sessionId: string,
): SessionLineageRow | undefined {
  const row = db
    .prepare(
      `
        SELECT ${sessionLineageColumns()}
        FROM sessions
        WHERE session_id = ?
      `,
    )
    .get(sessionId);

  if (row === undefined || row === null) {
    return undefined;
  }

  return buildSessionLineageRow(
    parseTypeBoxValue(
      SESSION_LINEAGE_QUERY_ROW_SCHEMA,
      row,
      `Invalid session row for ${sessionId}`,
    ),
  );
}

export function getSessionByPath(
  db: SessionIndexDatabase,
  sessionPath: string,
): SessionLineageRow | undefined {
  const row = db
    .prepare(
      `
        SELECT ${sessionLineageColumns()}
        FROM sessions
        WHERE session_path = ?
      `,
    )
    .get(sessionPath);

  if (row === undefined || row === null) {
    return undefined;
  }

  return buildSessionLineageRow(
    parseTypeBoxValue(
      SESSION_LINEAGE_QUERY_ROW_SCHEMA,
      row,
      `Invalid session row for path ${sessionPath}`,
    ),
  );
}

// Derived on every read rather than stored: a stored table needs a row for every
// pair of siblings, so each new child of a large family rewrites the whole family.
export function getLineageSessions(
  db: SessionIndexDatabase,
  sessionId: string,
): SessionRelatedSessionRow[] {
  const self = getSessionById(db, sessionId);
  if (!self) {
    return [];
  }

  const related = new Map<string, SessionRelatedSessionRow>();
  const relate = (row: SessionLineageRow, relation: SessionLineageRelation, distance: number) => {
    const candidate = { ...row, relation, distance };
    const existing = related.get(row.sessionId);
    if (!existing || compareRelations(candidate, existing) < 0) {
      related.set(row.sessionId, candidate);
    }
  };
  relate(self, "self", 0);

  const seenAncestors = new Set<string>();
  let current = self;
  for (let distance = 1; ; distance += 1) {
    const parent = getParentOf(db, current);
    if (!parent || seenAncestors.has(parent.sessionId)) {
      break;
    }

    seenAncestors.add(parent.sessionId);
    relate(parent, distance === 1 ? "parent" : "ancestor", distance);
    for (const sibling of getChildrenOf(db, [parent])) {
      if (sibling.sessionId !== current.sessionId) {
        relate(sibling, distance === 1 ? "sibling" : "ancestor_sibling", distance);
      }
    }
    current = parent;
  }

  const seenDescendants = new Set<string>();
  let generation = [self];
  for (let distance = 1; generation.length > 0; distance += 1) {
    generation = getChildrenOf(db, generation).filter((row) => !seenDescendants.has(row.sessionId));
    for (const descendant of generation) {
      seenDescendants.add(descendant.sessionId);
      relate(descendant, distance === 1 ? "child" : "descendant", distance);
    }
  }

  return [...related.values()].sort(
    (left, right) =>
      compareRelations(left, right) ||
      (left.modifiedAt < right.modifiedAt ? 1 : left.modifiedAt > right.modifiedAt ? -1 : 0),
  );
}

export function getLineageRelationMap(
  db: SessionIndexDatabase,
  sessionId: string,
): Map<string, SessionLineageRelation> {
  return new Map(getLineageSessions(db, sessionId).map((row) => [row.sessionId, row.relation]));
}

// A session's parent is the indexed session named by parent_session_id, else the
// indexed session at parent_session_path.
function getParentOf(
  db: SessionIndexDatabase,
  row: SessionLineageRow,
): SessionLineageRow | undefined {
  return (
    (row.parentSessionId ? getSessionById(db, row.parentSessionId) : undefined) ??
    (row.parentSessionPath ? getSessionByPath(db, row.parentSessionPath) : undefined)
  );
}

function getChildrenOf(
  db: SessionIndexDatabase,
  parents: SessionLineageRow[],
): SessionLineageRow[] {
  const parentIds = JSON.stringify(parents.map((parent) => parent.sessionId));
  return parseTypeBoxRows(
    SESSION_LINEAGE_QUERY_ROW_SCHEMA,
    db
      .prepare(
        `
          SELECT ${sessionLineageColumns("c")}
          FROM sessions c
          WHERE c.parent_session_id IN (SELECT value FROM json_each(?))
          UNION
          SELECT ${sessionLineageColumns("c")}
          FROM sessions c
          JOIN sessions p ON p.session_path = c.parent_session_path
          WHERE p.session_id IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (SELECT 1 FROM sessions named WHERE named.session_id = c.parent_session_id)
        `,
      )
      .all(parentIds, parentIds),
    "Invalid child session rows",
  ).map(buildSessionLineageRow);
}

const RELATION_PRIORITY: Record<SessionLineageRelation, number> = {
  self: 0,
  parent: 1,
  child: 2,
  sibling: 3,
  ancestor: 4,
  descendant: 5,
  ancestor_sibling: 6,
};

function compareRelations(
  left: { relation: SessionLineageRelation; distance: number },
  right: { relation: SessionLineageRelation; distance: number },
): number {
  return (
    RELATION_PRIORITY[left.relation] - RELATION_PRIORITY[right.relation] ||
    left.distance - right.distance
  );
}
