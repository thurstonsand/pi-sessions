import path from "node:path";
import {
  getDefaultIndexPath,
  getIndexStatus,
  getSessionById,
  INDEX_SCHEMA_VERSION,
  openIndexDatabase,
  type SessionLineageRow,
  type SessionOrigin,
} from "../session-search/db.js";
import { parseSessionFile } from "../session-search/extract.js";

const HANDOFF_REF_PREFIX = "@handoff/";
const SESSION_REFERENCE_HELP =
  "Expected an absolute session path, a raw session id, or @handoff/<full-session-id>.";

export type SessionReferenceKind = "path" | "session_id" | "handoff_ref";

export interface ResolvedSessionReference {
  input: string;
  kind: SessionReferenceKind;
  canonicalRef: string;
  sessionId: string;
  sessionPath: string;
  sessionName: string;
  parentSessionPath?: string | undefined;
  parentSessionId?: string | undefined;
  sessionOrigin?: SessionOrigin | undefined;
}

export interface SessionReferenceResolution {
  resolved?: ResolvedSessionReference | undefined;
  error?: string | undefined;
}

export function formatHandoffRef(sessionId: string): string {
  return `${HANDOFF_REF_PREFIX}${sessionId}`;
}

export function isHandoffRef(value: string): boolean {
  return value.startsWith(HANDOFF_REF_PREFIX);
}

export function resolveSessionReference(
  reference: string,
  options?: { indexPath?: string },
): SessionReferenceResolution {
  const trimmed = reference.trim();
  if (!trimmed) {
    return { error: `Missing session reference. ${SESSION_REFERENCE_HELP}` };
  }

  if (path.isAbsolute(trimmed)) {
    return resolveAbsoluteSessionPath(trimmed);
  }

  if (isHandoffRef(trimmed)) {
    return resolveIndexedReference(
      trimmed,
      trimmed.slice(HANDOFF_REF_PREFIX.length),
      "handoff_ref",
      options,
    );
  }

  return resolveIndexedReference(trimmed, trimmed, "session_id", options);
}

function resolveAbsoluteSessionPath(sessionPath: string): SessionReferenceResolution {
  try {
    const parsed = parseSessionFile(sessionPath);
    if (!parsed) {
      return { error: `Unable to parse session file: ${sessionPath}` };
    }

    return {
      resolved: {
        input: sessionPath,
        kind: "path",
        canonicalRef: formatHandoffRef(parsed.header.id),
        sessionId: parsed.header.id,
        sessionPath,
        sessionName: parsed.sessionName,
        parentSessionPath: normalizeOptionalString(parsed.header.parentSession),
      },
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { error: `Session file not found: ${sessionPath}` };
    }

    return { error: `Unable to load session file: ${sessionPath}` };
  }
}

function resolveIndexedReference(
  input: string,
  rawValue: string,
  kind: SessionReferenceKind,
  options?: { indexPath?: string },
): SessionReferenceResolution {
  const value = rawValue.trim();
  if (!value) {
    return { error: `Invalid session reference: ${input}. ${SESSION_REFERENCE_HELP}` };
  }

  const status = getIndexStatus(options?.indexPath ?? getDefaultIndexPath());
  if (!status.exists || status.schemaVersion !== INDEX_SCHEMA_VERSION) {
    return {
      error: `Session reference resolution requires a current index at ${status.dbPath}. Run /session-index and press r to rebuild it.`,
    };
  }

  const db = openIndexDatabase(status.dbPath, { create: false });
  try {
    const exactMatch = getSessionById(db, value);
    if (exactMatch) {
      return { resolved: buildResolvedReference(input, kind, exactMatch) };
    }

    return { error: `No session found for reference: ${input}. ${SESSION_REFERENCE_HELP}` };
  } finally {
    db.close();
  }
}

function buildResolvedReference(
  input: string,
  kind: SessionReferenceKind,
  session: SessionLineageRow,
): ResolvedSessionReference {
  return {
    input,
    kind,
    canonicalRef: formatHandoffRef(session.sessionId),
    sessionId: session.sessionId,
    sessionPath: session.sessionPath,
    sessionName: session.sessionName,
    parentSessionPath: session.parentSessionPath,
    parentSessionId: session.parentSessionId,
    sessionOrigin: session.sessionOrigin,
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
