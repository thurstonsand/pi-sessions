import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay, setImmediate as yieldToEventLoop } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { listSessionFiles } from "../../session-search/extract.ts";
import { parseTypeBoxValue } from "../typebox.ts";
import { INDEX_SCHEMA_VERSION, ROW_COUNT_SCHEMA, type SessionIndexDatabase } from "./common.ts";
import {
  ensureIndexDir,
  getMetadata,
  initializeSchema,
  openIndexDatabase,
  setMetadata,
} from "./schema.ts";
import { isSqliteBusy } from "./sqlite.ts";
import { syncSessionFileWithDb } from "./sync.ts";

export const INDEX_UPDATED_WARNING = "pi-sessions was updated; /reload to use it";
const BUILD = `index-v${INDEX_SCHEMA_VERSION}:${createHash("sha256")
  .update(
    ["recovery.ts", "schema.ts", "sync.ts"]
      .map((file) => readFileSync(new URL(file, import.meta.url)))
      .join(""),
  )
  .digest("hex")
  .slice(0, 16)}`;
const FAILURE_SCHEMA = Type.Object({
  attempts: Type.Integer({ minimum: 1 }),
  nextAllowedAt: Type.Number(),
  error: Type.String(),
  build: Type.String(),
});
export type IndexRecoveryFailure = Static<typeof FAILURE_SCHEMA>;
export interface ReindexResult {
  sessionCount: number;
  chunkCount: number;
  indexPath: string;
  skipped: string[];
}
const running = new Map<string, Promise<ReindexResult | undefined>>();
const notices = new Map<string, (message: string | undefined) => void>();
const shown = new Map<string, string>();
const disabled = new Set<string>();

export function observeIndexRecovery(
  indexPath: string,
  notify: (message: string | undefined) => void,
): void {
  notices.set(indexPath, notify);
  const message = getIndexRecoveryMessage(indexPath);
  notify(message);
  if (message) shown.set(indexPath, message);
}

function report(indexPath: string, message: string): void {
  if (shown.get(indexPath) === message) return;
  shown.set(indexPath, message);
  const notify = notices.get(indexPath);
  if (notify) notify(message);
  else console.error(message);
}

export function disableOlderIndexClient(indexPath: string): void {
  disabled.add(indexPath);
  report(indexPath, INDEX_UPDATED_WARNING);
}

export function isIndexClientDisabled(indexPath: string): boolean {
  return disabled.has(indexPath);
}

export function readIndexRecoveryFailure(indexPath: string): IndexRecoveryFailure | undefined {
  const file = `${indexPath}.failure.json`;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  return parseTypeBoxValue(FAILURE_SCHEMA, JSON.parse(raw), "Invalid index recovery record");
}

export function getIndexRecoveryMessage(indexPath: string): string | undefined {
  if (disabled.has(indexPath)) return INDEX_UPDATED_WARNING;
  const failure = readIndexRecoveryFailure(indexPath);
  if (failure)
    return `Session indexing failed: ${failure.error}. Retry after ${new Date(failure.nextAllowedAt).toISOString()}; /session-index can rebuild now.`;
  if (running.has(indexPath)) return "Session indexing in progress; try again shortly.";
  if (existsSync(`${indexPath}.lock.sqlite`)) {
    const release = acquireIndexLock(indexPath);
    if (!release) return "Session indexing in progress; try again shortly.";
    release();
  }
  return undefined;
}

// All index writers share this lock with recovery. Reads are short-lived and may
// finish on the old inode after an atomic replacement (no WAL sidecars).
// SQLite owns the lock lifetime, including process death; never unlink its file.
export function acquireIndexLock(indexPath: string): (() => void) | undefined {
  ensureIndexDir(dirname(indexPath));
  let lock: SessionIndexDatabase | undefined;
  try {
    lock = openIndexDatabase(`${indexPath}.lock.sqlite`, { create: true, timeoutMs: 0 });
    lock.exec("BEGIN EXCLUSIVE");
    const held = lock;
    return () => held.close();
  } catch (error) {
    lock?.close();
    if (isSqliteBusy(error)) return undefined;
    throw error;
  }
}

export function requestIndexRecovery(
  indexPath: string,
  reconcile = false,
): Promise<ReindexResult | undefined> {
  const pending = running.get(indexPath);
  if (pending) return pending;
  const sessionsDir = join(getAgentDir(), "sessions");
  const task = yieldToEventLoop()
    .then(() => recover(indexPath, sessionsDir, false, reconcile))
    .catch((error: unknown) => {
      report(indexPath, `Session indexing failed: ${String(error)}`);
      return undefined;
    })
    .finally(() => running.delete(indexPath));
  running.set(indexPath, task);
  return task;
}

export async function rebuildSessionIndex(options: { indexPath: string }): Promise<ReindexResult> {
  await running.get(options.indexPath);
  const result = await recover(options.indexPath, join(getAgentDir(), "sessions"), true, true);
  if (!result)
    throw new Error(
      getIndexRecoveryMessage(options.indexPath) ?? "Session index is busy; try again shortly.",
    );
  return result;
}

async function recover(
  indexPath: string,
  sessionsDir: string,
  manual: boolean,
  reconcileRequested: boolean,
): Promise<ReindexResult | undefined> {
  if (disabled.has(indexPath)) return undefined;
  let release = acquireIndexLock(indexPath);
  const deadline = Date.now() + 30_000;
  while (!release && Date.now() < deadline) {
    await delay(50);
    release = acquireIndexLock(indexPath);
  }
  if (!release) return undefined;
  try {
    const failure = readIndexRecoveryFailure(indexPath);
    let version: number | undefined;
    let corrupt = false;
    if (existsSync(indexPath)) {
      try {
        const probe = openIndexDatabase(indexPath, { create: false, mode: "read" });
        try {
          version = Number(getMetadata(probe, "schema_version"));
          if (version > INDEX_SCHEMA_VERSION) {
            disableOlderIndexClient(indexPath);
            return undefined;
          }
          probe.prepare("SELECT COUNT(*) FROM sessions").get();
        } finally {
          probe.close();
        }
      } catch (error) {
        if (isSqliteBusy(error)) throw error;
        corrupt = true;
      }
    }
    if (!manual && failure && Date.now() < failure.nextAllowedAt) {
      report(indexPath, getIndexRecoveryMessage(indexPath) ?? failure.error);
      return undefined;
    }
    const stale = manual || corrupt || version !== INDEX_SCHEMA_VERSION;
    if (!stale && !reconcileRequested) {
      if (!failure) notices.get(indexPath)?.(undefined);
      return undefined;
    }
    const result = stale
      ? await rebuild(indexPath, sessionsDir, corrupt)
      : await reconcile(indexPath, sessionsDir);
    rmSync(`${indexPath}.failure.json`, { force: true });
    shown.delete(indexPath);
    notices.get(indexPath)?.(undefined);
    if (result.skipped.length)
      report(
        indexPath,
        `Session index skipped ${result.skipped.length} unreadable transcript(s): ${result.skipped.join(", ")}`,
      );
    return result;
  } catch (error) {
    const attempts = (readIndexRecoveryFailure(indexPath)?.attempts ?? 0) + 1;
    const failure: IndexRecoveryFailure = {
      attempts,
      nextAllowedAt: Date.now() + (attempts === 1 ? 60_000 : attempts === 2 ? 300_000 : 1_800_000),
      error: error instanceof Error ? error.message : String(error),
      build: BUILD,
    };
    const record = `${indexPath}.failure.json`;
    writeFileSync(`${record}.tmp`, JSON.stringify(failure));
    renameSync(`${record}.tmp`, record);
    report(indexPath, getIndexRecoveryMessage(indexPath) ?? failure.error);
    if (manual) throw error;
    return undefined;
  } finally {
    release();
  }
}

async function rebuild(
  indexPath: string,
  sessionsDir: string,
  corrupt: boolean,
): Promise<ReindexResult> {
  const temp = `${indexPath}.${randomUUID()}.tmp`;
  let db: SessionIndexDatabase | undefined = openIndexDatabase(temp, { create: true });
  try {
    initializeSchema(db);
    const result = await walk(db, indexPath, sessionsDir);
    const built = db;
    db.transaction(() => {
      setMetadata(built, "indexed_at", new Date().toISOString());
      setMetadata(built, "build", BUILD);
    });
    db.close();
    db = undefined;
    if (corrupt) {
      const backup = `${indexPath}.bad-${Date.now()}-${randomUUID()}`;
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        if (existsSync(`${indexPath}${suffix}`))
          renameSync(`${indexPath}${suffix}`, `${backup}${suffix}`);
      }
    } else if (existsSync(indexPath)) {
      // Upgrade legacy WAL indexes before swapping: SQLite checkpoints and
      // refuses the mode change while another connection still needs its WAL.
      const previous = openIndexDatabase(indexPath, { create: false });
      previous.close();
    }
    renameSync(temp, indexPath);
    return result;
  } finally {
    db?.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      rmSync(`${temp}${suffix}`, { force: true });
  }
}

async function reconcile(indexPath: string, sessionsDir: string): Promise<ReindexResult> {
  const db = openIndexDatabase(indexPath, { create: false });
  try {
    const result = await walk(db, indexPath, sessionsDir);
    db.transaction(() => setMetadata(db, "reconciled_at", new Date().toISOString()));
    return result;
  } finally {
    db.close();
  }
}

async function walk(
  db: SessionIndexDatabase,
  indexPath: string,
  sessionsDir: string,
): Promise<ReindexResult> {
  const skipped: string[] = [];
  for (const file of listSessionFiles(sessionsDir)) {
    if (!syncSessionFileWithDb(db, file, "reconcile")) skipped.push(file);
    await yieldToEventLoop();
  }
  const count = (table: string) =>
    parseTypeBoxValue(
      ROW_COUNT_SCHEMA,
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      "Invalid index count",
    ).count;
  return {
    sessionCount: count("sessions"),
    chunkCount: count("session_text_chunks"),
    indexPath,
    skipped,
  };
}
