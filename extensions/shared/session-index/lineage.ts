import { type Static, Type } from "typebox";
import { parseTypeBoxRows, parseTypeBoxValue } from "../typebox.ts";
import {
  NULLABLE_STRING_SCHEMA,
  parseRepoRoots,
  SESSION_LINEAGE_RELATION_SCHEMA,
  SESSION_ORIGIN_SCHEMA,
  type SessionIndexDatabase,
  type SessionLineageRelation,
  type SessionLineageRow,
  type SessionRelatedSessionRow,
} from "./common.ts";

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

export function getLineageSessions(
  db: SessionIndexDatabase,
  sessionId: string,
): SessionRelatedSessionRow[] {
  return queryRelatedSessions(db, sessionId);
}

export function getLineageRelationMap(
  db: SessionIndexDatabase,
  sessionId: string,
): Map<string, SessionLineageRelation> {
  return new Map(getLineageSessions(db, sessionId).map((row) => [row.sessionId, row.relation]));
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

interface SessionGraph {
  nodes: Map<string, SessionGraphNode>;
  childrenByParent: Map<string, string[]>;
}

export function rebuildSessionLineageRelations(db: SessionIndexDatabase): void {
  db.prepare(`DELETE FROM session_lineage_relations`).run();

  const graph = buildSessionGraph(db);
  insertLineageRelationRows(db, graph.nodes.keys(), graph);
}

// Recomputes lineage for just the connected component(s) containing the seed
// sessions. Lineage relations only ever link sessions connected through parent
// edges, so the rest of the table is untouched.
export function refreshSessionLineageRelationsFor(
  db: SessionIndexDatabase,
  seedSessionIds: Array<string | undefined>,
): void {
  const graph = buildSessionGraph(db);
  const component = collectLineageComponent(seedSessionIds, graph);
  if (component.size === 0) {
    return;
  }

  const placeholders = [...component].map(() => "?").join(", ");
  db.prepare(`DELETE FROM session_lineage_relations WHERE session_id IN (${placeholders})`).run(
    ...component,
  );
  insertLineageRelationRows(db, component, graph);
}

function buildSessionGraph(db: SessionIndexDatabase): SessionGraph {
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

  const sessionIds = new Set(rows.map((row) => row.sessionId));
  const pathToId = new Map(rows.map((row) => [row.sessionPath, row.sessionId]));
  const nodes = new Map<string, SessionGraphNode>(
    rows.map((row) => [
      row.sessionId,
      {
        ...row,
        resolvedParentSessionId:
          row.parentSessionId && sessionIds.has(row.parentSessionId)
            ? row.parentSessionId
            : row.parentSessionPath
              ? pathToId.get(row.parentSessionPath)
              : undefined,
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

  return { nodes, childrenByParent };
}

function collectLineageComponent(
  seedSessionIds: Array<string | undefined>,
  graph: SessionGraph,
): Set<string> {
  const component = new Set<string>();
  const queue = seedSessionIds.filter(
    (sessionId): sessionId is string => sessionId !== undefined && graph.nodes.has(sessionId),
  );

  while (queue.length > 0) {
    const sessionId = queue.pop();
    if (!sessionId || component.has(sessionId)) {
      continue;
    }

    component.add(sessionId);
    const parentId = graph.nodes.get(sessionId)?.resolvedParentSessionId;
    if (parentId) {
      queue.push(parentId);
    }
    queue.push(...(graph.childrenByParent.get(sessionId) ?? []));
  }

  return component;
}

function insertLineageRelationRows(
  db: SessionIndexDatabase,
  sessionIds: Iterable<string>,
  graph: SessionGraph,
): void {
  const insertRelation = db.prepare(
    `
      INSERT INTO session_lineage_relations(session_id, related_session_id, relation, distance)
      VALUES (?, ?, ?, ?)
    `,
  );

  for (const sessionId of sessionIds) {
    const relations = collectMaterializedLineageRows(
      sessionId,
      graph.nodes,
      graph.childrenByParent,
    );
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
              WHEN 'self' THEN 0
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
  setMaterializedLineageRow(relations, {
    sessionId,
    relatedSessionId: sessionId,
    relation: "self",
    distance: 0,
  });

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
    case "self":
      return 0;
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
