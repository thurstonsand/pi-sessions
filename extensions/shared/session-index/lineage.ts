import { type Static, Type } from "@sinclair/typebox";
import { parseTypeBoxRows, parseTypeBoxValue } from "../typebox.js";
import {
  NULLABLE_STRING_SCHEMA,
  parseRepoRoots,
  SESSION_LINEAGE_RELATION_SCHEMA,
  SESSION_ORIGIN_SCHEMA,
  type SessionIndexDatabase,
  type SessionLineageRelation,
  type SessionLineageRow,
  type SessionRelatedSessionRow,
} from "./common.js";

const SESSION_GRAPH_ROW_SCHEMA = Type.Object({
  sessionId: Type.String(),
  sessionPath: Type.String(),
  parentSessionPath: NULLABLE_STRING_SCHEMA,
  parentSessionId: NULLABLE_STRING_SCHEMA,
});

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
  handoffGoal: NULLABLE_STRING_SCHEMA,
  handoffNextTask: NULLABLE_STRING_SCHEMA,
});

const SESSION_RELATED_QUERY_ROW_SCHEMA = Type.Intersect([
  SESSION_LINEAGE_QUERY_ROW_SCHEMA,
  Type.Object({
    relation: SESSION_LINEAGE_RELATION_SCHEMA,
    distance: Type.Number(),
  }),
]);

type SessionGraphNode = Static<typeof SESSION_GRAPH_ROW_SCHEMA> & {
  resolvedParentSessionId?: string | undefined;
};

interface MaterializedLineageRow {
  sessionId: string;
  relatedSessionId: string;
  relation: SessionLineageRelation;
  distance: number;
}

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
    `${prefix}handoff_goal as handoffGoal`,
    `${prefix}handoff_next_task as handoffNextTask`,
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
    handoffGoal: row.handoffGoal ?? undefined,
    handoffNextTask: row.handoffNextTask ?? undefined,
  };
}

function buildRelatedSessionRow(
  row: Static<typeof SESSION_RELATED_QUERY_ROW_SCHEMA>,
): SessionRelatedSessionRow {
  return {
    ...buildSessionLineageRow(row),
    relation: row.relation,
    distance: row.distance,
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

  if (row === undefined) {
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

  if (row === undefined) {
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

export function getLineageSessions(
  db: SessionIndexDatabase,
  sessionId: string,
): SessionRelatedSessionRow[] {
  return queryRelatedSessions(db, sessionId);
}

export function getParentSession(
  db: SessionIndexDatabase,
  sessionId: string,
): SessionLineageRow | undefined {
  return queryRelatedSessions(db, sessionId, ["parent"])[0];
}

export function getAncestorSessions(
  db: SessionIndexDatabase,
  sessionId: string,
): SessionLineageRow[] {
  return queryRelatedSessions(db, sessionId, ["parent", "ancestor"]);
}

export function getChildSessions(db: SessionIndexDatabase, sessionId: string): SessionLineageRow[] {
  return queryRelatedSessions(db, sessionId, ["child"]);
}

export function getSiblingSessions(
  db: SessionIndexDatabase,
  sessionId: string,
): SessionLineageRow[] {
  return queryRelatedSessions(db, sessionId, ["sibling"]);
}

export function rebuildSessionLineageRelations(db: SessionIndexDatabase): void {
  db.prepare(`DELETE FROM session_lineage_relations`).run();

  const rows = parseTypeBoxRows(
    SESSION_GRAPH_ROW_SCHEMA,
    db
      .prepare(
        `
          SELECT
            session_id as sessionId,
            session_path as sessionPath,
            parent_session_path as parentSessionPath,
            parent_session_id as parentSessionId
          FROM sessions
        `,
      )
      .all(),
    "Invalid session graph rows",
  );

  const pathToId = new Map(rows.map((row) => [row.sessionPath, row.sessionId]));
  const nodes = new Map<string, SessionGraphNode>(
    rows.map((row) => [
      row.sessionId,
      {
        ...row,
        resolvedParentSessionId:
          row.parentSessionId ??
          (row.parentSessionPath ? pathToId.get(row.parentSessionPath) : undefined),
      },
    ]),
  );
  const childrenByParent = new Map<string, string[]>();

  for (const node of nodes.values()) {
    if (!node.resolvedParentSessionId) {
      continue;
    }

    const children = childrenByParent.get(node.resolvedParentSessionId) ?? [];
    children.push(node.sessionId);
    childrenByParent.set(node.resolvedParentSessionId, children);
  }

  const insertRelation = db.prepare(
    `
      INSERT INTO session_lineage_relations(session_id, related_session_id, relation, distance)
      VALUES (?, ?, ?, ?)
    `,
  );

  for (const node of nodes.values()) {
    const relations = collectMaterializedLineageRows(node.sessionId, nodes, childrenByParent);
    for (const relation of relations.values()) {
      insertRelation.run(
        relation.sessionId,
        relation.relatedSessionId,
        relation.relation,
        relation.distance,
      );
    }
  }
}

function queryRelatedSessions(
  db: SessionIndexDatabase,
  sessionId: string,
  relations?: SessionLineageRelation[],
): SessionRelatedSessionRow[] {
  const relationFilter = relations?.length
    ? ` AND r.relation IN (${relations.map(() => "?").join(", ")})`
    : "";
  const rows = parseTypeBoxRows(
    SESSION_RELATED_QUERY_ROW_SCHEMA,
    db
      .prepare(
        `
          SELECT
            ${sessionLineageColumns("s")},
            r.relation as relation,
            r.distance as distance
          FROM session_lineage_relations r
          JOIN sessions s ON s.session_id = r.related_session_id
          WHERE r.session_id = ?${relationFilter}
          ORDER BY
            CASE r.relation
              WHEN 'parent' THEN 1
              WHEN 'child' THEN 2
              WHEN 'sibling' THEN 3
              WHEN 'ancestor' THEN 4
              WHEN 'descendant' THEN 5
              WHEN 'ancestor_sibling' THEN 6
              ELSE 7
            END ASC,
            r.distance ASC,
            s.modified_ts DESC
        `,
      )
      .all(sessionId, ...(relations ?? [])),
    `Invalid related session rows for ${sessionId}`,
  );

  return rows.map(buildRelatedSessionRow);
}

function collectMaterializedLineageRows(
  sessionId: string,
  nodes: Map<string, SessionGraphNode>,
  childrenByParent: Map<string, string[]>,
): Map<string, MaterializedLineageRow> {
  const relations = new Map<string, MaterializedLineageRow>();
  const visitedAncestors = new Set<string>();
  const ancestors: Array<{ sessionId: string; distance: number }> = [];

  let currentId = nodes.get(sessionId)?.resolvedParentSessionId;
  let distance = 1;
  while (currentId && !visitedAncestors.has(currentId)) {
    visitedAncestors.add(currentId);
    ancestors.push({ sessionId: currentId, distance });
    setMaterializedLineageRow(relations, {
      sessionId,
      relatedSessionId: currentId,
      relation: distance === 1 ? "parent" : "ancestor",
      distance,
    });
    currentId = nodes.get(currentId)?.resolvedParentSessionId;
    distance += 1;
  }

  const visitedDescendants = new Set<string>();
  const queue = (childrenByParent.get(sessionId) ?? []).map((childId) => ({
    childId,
    distance: 1,
  }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || visitedDescendants.has(next.childId)) {
      continue;
    }

    visitedDescendants.add(next.childId);
    setMaterializedLineageRow(relations, {
      sessionId,
      relatedSessionId: next.childId,
      relation: next.distance === 1 ? "child" : "descendant",
      distance: next.distance,
    });

    for (const childId of childrenByParent.get(next.childId) ?? []) {
      queue.push({ childId, distance: next.distance + 1 });
    }
  }

  const parentId = nodes.get(sessionId)?.resolvedParentSessionId;
  if (parentId) {
    for (const siblingId of childrenByParent.get(parentId) ?? []) {
      if (siblingId === sessionId) {
        continue;
      }

      setMaterializedLineageRow(relations, {
        sessionId,
        relatedSessionId: siblingId,
        relation: "sibling",
        distance: 1,
      });
    }
  }

  for (const ancestor of ancestors) {
    const ancestorParentId = nodes.get(ancestor.sessionId)?.resolvedParentSessionId;
    if (!ancestorParentId) {
      continue;
    }

    for (const siblingId of childrenByParent.get(ancestorParentId) ?? []) {
      if (siblingId === ancestor.sessionId) {
        continue;
      }

      setMaterializedLineageRow(relations, {
        sessionId,
        relatedSessionId: siblingId,
        relation: "ancestor_sibling",
        distance: ancestor.distance + 1,
      });
    }
  }

  return relations;
}

function setMaterializedLineageRow(
  rows: Map<string, MaterializedLineageRow>,
  candidate: MaterializedLineageRow,
): void {
  const existing = rows.get(candidate.relatedSessionId);
  if (!existing) {
    rows.set(candidate.relatedSessionId, candidate);
    return;
  }

  const existingPriority = getLineageRelationPriority(existing.relation);
  const candidatePriority = getLineageRelationPriority(candidate.relation);
  if (candidatePriority < existingPriority) {
    rows.set(candidate.relatedSessionId, candidate);
    return;
  }

  if (candidatePriority === existingPriority && candidate.distance < existing.distance) {
    rows.set(candidate.relatedSessionId, candidate);
  }
}

function getLineageRelationPriority(relation: SessionLineageRelation): number {
  switch (relation) {
    case "parent":
      return 1;
    case "child":
      return 2;
    case "sibling":
      return 3;
    case "ancestor":
      return 4;
    case "descendant":
      return 5;
    case "ancestor_sibling":
      return 6;
  }
}
