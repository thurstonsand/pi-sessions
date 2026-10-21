import { existsSync } from "node:fs";
import { parseTypeBoxValue } from "../typebox.ts";
import {
  INDEX_SCHEMA_VERSION,
  ROW_COUNT_SCHEMA,
  type SessionIndexDatabase,
  type SessionIndexStatus,
} from "./common.ts";
import {
  disableOlderIndexClient,
  getIndexRecoveryMessage,
  isIndexClientDisabled,
  requestIndexRecovery,
} from "./recovery.ts";
import { getMetadata, openIndexDatabase } from "./schema.ts";
import { isSqliteBusy } from "./sqlite.ts";

export type SessionIndexOpenMode = "read" | "write";

export interface WithSessionIndexOptions {
  mode: SessionIndexOpenMode;
  required: boolean;
  timeoutMs?: number | undefined;
}

export interface ValidSessionIndex {
  db: SessionIndexDatabase;
  status: SessionIndexStatus;
}

export function withSessionIndex<T>(
  indexPath: string,
  options: WithSessionIndexOptions & { required: true },
  read: (index: ValidSessionIndex) => T,
): T;
export function withSessionIndex<T>(
  indexPath: string,
  options: WithSessionIndexOptions & { required: false },
  read: (index: ValidSessionIndex) => T,
): T | undefined;
export function withSessionIndex<T>(
  indexPath: string,
  options: WithSessionIndexOptions,
  read: (index: ValidSessionIndex) => T,
): T | undefined {
  const index = openValidatedSessionIndex(indexPath, options);
  if (!index) return undefined;
  try {
    return read(index);
  } finally {
    index.db.close();
  }
}

function openValidatedSessionIndex(
  indexPath: string,
  options: WithSessionIndexOptions,
): ValidSessionIndex | undefined {
  if (isIndexClientDisabled(indexPath) || !existsSync(indexPath))
    return handleUnavailableIndex(indexPath, options);

  let db: SessionIndexDatabase | undefined;
  let version: number;
  try {
    db = openIndexDatabase(indexPath, {
      create: false,
      mode: options.mode,
      timeoutMs: options.timeoutMs,
    });
    version = Number(getMetadata(db, "schema_version"));
    if (version === INDEX_SCHEMA_VERSION)
      return { db, status: getIndexStatusFromDb(indexPath, db) };
  } catch (error) {
    db?.close();
    if (isSqliteBusy(error)) throw error;
    return handleUnavailableIndex(indexPath, options, error);
  }
  db.close();
  if (version > INDEX_SCHEMA_VERSION) disableOlderIndexClient(indexPath);
  return handleUnavailableIndex(indexPath, options);
}

export function getIndexStatusFromDb(dbPath: string, db: SessionIndexDatabase): SessionIndexStatus {
  const schemaVersionRaw = getMetadata(db, "schema_version");
  const lastFullReindexAt = getMetadata(db, "indexed_at");
  const sessionCountRow = parseTypeBoxValue(
    ROW_COUNT_SCHEMA,
    db.prepare(`SELECT COUNT(*) as count FROM sessions`).get(),
    "Invalid session count row",
  );

  return {
    dbPath,
    exists: true,
    schemaVersion: schemaVersionRaw ? Number(schemaVersionRaw) : undefined,
    sessionCount: sessionCountRow.count,
    lastFullReindexAt,
  };
}

export function formatRequiredSessionIndexError(indexPath: string): string {
  return getIndexRecoveryMessage(indexPath) ?? "Session indexing in progress; try again shortly.";
}

function handleUnavailableIndex(
  indexPath: string,
  options: WithSessionIndexOptions,
  cause?: unknown,
): undefined {
  if (!isIndexClientDisabled(indexPath)) void requestIndexRecovery(indexPath);
  if (!options.required) {
    return undefined;
  }

  throw new Error(formatRequiredSessionIndexError(indexPath), { cause });
}
