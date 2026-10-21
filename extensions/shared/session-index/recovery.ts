import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay, setImmediate as yieldToEventLoop } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { listSessionFiles } from "../../session-search/extract.ts";
import { parseTypeBoxValue } from "../typebox.ts";
import { withSessionIndex } from "./access.ts";
import { INDEX_SCHEMA_VERSION, ROW_COUNT_SCHEMA, type SessionIndexDatabase } from "./common.ts";
import {
  ensureIndexDir,
  getMetadata,
  initializeSchema,
  openIndexDatabase,
  replaceIndexContents,
  setMetadata,
} from "./schema.ts";
import { isSqliteBusy } from "./sqlite.ts";
import { syncSessionFileInTransaction, syncSessionFileWithDb } from "./sync.ts";

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
const TEMP_SUFFIX = /^[0-9a-f-]{36}\.tmp(-journal|-wal|-shm)?$/;
// SQLite's busy_timeout is a C int of milliseconds (about 24.8 days).
const MAX_BUSY_TIMEOUT_MS = 2 ** 31 - 1;
const heldLocks = new Set<string>();
const running = new Map<string, Promise<ReindexResult | undefined>>();
const notices = new Map<string, (message: string | undefined) => void>();
const shown = new Map<string, string>();
const disabled = new Set<string>();

export function observeIndexRecovery(
  indexPath: string,
  notify: (message: string | undefined) => void,
): () => void {
  const message = getIndexRecoveryMessage(indexPath);
  notify(message);
  notices.set(indexPath, notify);
  if (message) shown.set(indexPath, message);
  return () => {
    if (notices.get(indexPath) === notify) notices.delete(indexPath);
  };
}

function report(indexPath: string, message: string): void {
  if (shown.get(indexPath) === message) return;
  shown.set(indexPath, message);
  const notify = notices.get(indexPath);
  if (notify) notify(message);
  else console.error(message);
}

export class IndexClientDisabledError extends Error {
  constructor() {
    super(INDEX_UPDATED_WARNING);
  }
}

export function disableOlderIndexClient(indexPath: string): void {
  disabled.add(indexPath);
}

export function reportIndexClientDisabled(indexPath: string): void {
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

// Serializes rebuilds only; ordinary writers rely on SQLite's own write lock.
// SQLite owns the lock lifetime, including process death; never unlink its file.
export function acquireIndexLock(indexPath: string, timeoutMs = 0): (() => void) | undefined {
  ensureIndexDir(dirname(indexPath));
  let lock: SessionIndexDatabase | undefined;
  try {
    lock = openIndexDatabase(`${indexPath}.lock.sqlite`, { create: true, timeoutMs });
    lock.exec("BEGIN EXCLUSIVE");
    const held = lock;
    heldLocks.add(indexPath);
    return () => {
      heldLocks.delete(indexPath);
      held.close();
    };
  } catch (error) {
    lock?.close();
    if (isSqliteBusy(error)) return undefined;
    throw error;
  }
}

// A rebuild is stop-the-world: a writer it blocks waits for it to finish, however
// long that takes. Returns false when no other process is rebuilding, including
// when this process holds the lock and waiting would deadlock its own rebuild.
export function waitForIndexRebuild(indexPath: string): boolean {
  if (heldLocks.has(indexPath)) return false;
  const free = acquireIndexLock(indexPath);
  if (free) {
    free();
    return false;
  }
  acquireIndexLock(indexPath, MAX_BUSY_TIMEOUT_MS)?.();
  return true;
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
    .finally(() => running.delete(indexPath))
    // Separate handlers: an observer that throws must not be reported as an indexing failure.
    .then(
      (result) => {
        publishRecovery(indexPath, result);
        return result;
      },
      (error: unknown) => {
        reportRecoveryFailure(indexPath, error);
        return undefined;
      },
    );
  running.set(indexPath, task);
  return task;
}

export async function rebuildSessionIndex(options: { indexPath: string }): Promise<ReindexResult> {
  const { indexPath } = options;
  await running.get(indexPath);
  let result: ReindexResult | undefined;
  try {
    result = await recover(indexPath, join(getAgentDir(), "sessions"), true, true);
  } catch (error) {
    reportRecoveryFailure(indexPath, error);
    throw error;
  }
  publishRecovery(indexPath, result);
  if (!result)
    throw new Error(
      getIndexRecoveryMessage(indexPath) ?? "Session index is busy; try again shortly.",
    );
  return result;
}

function publishRecovery(indexPath: string, result: ReindexResult | undefined): void {
  const message = getIndexRecoveryMessage(indexPath);
  if (message) {
    report(indexPath, message);
  } else {
    shown.delete(indexPath);
    notices.get(indexPath)?.(undefined);
  }
  if (result?.skipped.length)
    report(
      indexPath,
      `Session index skipped ${result.skipped.length} unreadable transcript(s): ${result.skipped.join(", ")}`,
    );
}

function reportRecoveryFailure(indexPath: string, error: unknown): void {
  report(
    indexPath,
    getIndexRecoveryMessage(indexPath) ?? `Session indexing failed: ${String(error)}`,
  );
}

// Index work and durable failure records only; observers are notified by the callers above.
async function recover(
  indexPath: string,
  sessionsDir: string,
  manual: boolean,
  reconcileRequested: boolean,
): Promise<ReindexResult | undefined> {
  if (disabled.has(indexPath)) return undefined;
  try {
    const failure = readIndexRecoveryFailure(indexPath);
    // Read-only, so a writer cannot stall it; rebuild re-probes authoritatively.
    const state = probeIndex(indexPath, "read");
    if (state === "newer") {
      disableOlderIndexClient(indexPath);
      return undefined;
    }
    if (!manual && failure && Date.now() < failure.nextAllowedAt) return undefined;
    if (state === "current" && !manual && !reconcileRequested) return undefined;
    if ((manual || state !== "current") && !(await rebuild(indexPath, sessionsDir, manual)))
      return undefined;
    const result = await reconcile(indexPath, sessionsDir);
    rmSync(`${indexPath}.failure.json`, { force: true });
    return result;
  } catch (error) {
    // A newer client published mid-recovery: stop, but leave the shared backoff to it.
    if (error instanceof IndexClientDisabledError) return undefined;
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
    throw error;
  }
}

function probeIndex(
  indexPath: string,
  mode: "read" | "write",
): "missing" | "corrupt" | "older" | "current" | "newer" {
  if (!existsSync(indexPath)) return "missing";
  try {
    const probe = openIndexDatabase(indexPath, { create: false, mode });
    try {
      const version = Number(getMetadata(probe, "schema_version"));
      if (version > INDEX_SCHEMA_VERSION) return "newer";
      probe.prepare("SELECT COUNT(*) FROM sessions").get();
      return version === INDEX_SCHEMA_VERSION ? "current" : "older";
    } finally {
      probe.close();
    }
  } catch (error) {
    if (isSqliteBusy(error)) throw error;
    return "corrupt";
  }
}

// Only the lock holder builds temps, so any found under the lock are left by a crash.
function removeOrphanedTemps(indexPath: string): void {
  const prefix = `${basename(indexPath)}.`;
  for (const name of readdirSync(dirname(indexPath))) {
    if (name.startsWith(prefix) && TEMP_SUFFIX.test(name.slice(prefix.length)))
      rmSync(join(dirname(indexPath), name), { force: true });
  }
}

// Returns false when another rebuilder kept the lock, failed while this one waited for it,
// or found the index newer.
async function rebuild(indexPath: string, sessionsDir: string, manual: boolean): Promise<boolean> {
  let release = acquireIndexLock(indexPath);
  const deadline = Date.now() + 30_000;
  while (!release && Date.now() < deadline) {
    await delay(50);
    release = acquireIndexLock(indexPath);
  }
  if (!release) return false;
  const failure = readIndexRecoveryFailure(indexPath);
  if (!manual && failure && Date.now() < failure.nextAllowedAt) {
    release();
    return false;
  }
  removeOrphanedTemps(indexPath);
  const temp = `${indexPath}.${randomUUID()}.tmp`;
  let db: SessionIndexDatabase | undefined;
  try {
    // Read-write, so a crashed writer's hot journal is rolled back rather than
    // failing a read-only open and looking like corruption.
    const state = probeIndex(indexPath, "write");
    if (state === "newer") {
      disableOlderIndexClient(indexPath);
      return false;
    }
    if (state === "current" && !manual) return true;
    db = openIndexDatabase(temp, { create: true });
    initializeSchema(db);
    const built = db;
    await walk(sessionsDir, (file) => syncSessionFileWithDb(built, file, "reconcile"));
    db.transaction(() => {
      setMetadata(built, "indexed_at", new Date().toISOString());
      setMetadata(built, "build", BUILD);
    });
    db.close();
    db = undefined;
    if (state === "corrupt") {
      const backup = `${indexPath}.bad-${Date.now()}-${randomUUID()}`;
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        if (existsSync(`${indexPath}${suffix}`))
          renameSync(`${indexPath}${suffix}`, `${backup}${suffix}`);
      }
      renameSync(temp, indexPath);
    } else if (state === "missing") {
      renameSync(temp, indexPath);
    } else {
      const live = openIndexDatabase(indexPath, { create: false });
      try {
        // Writes committed while the temp was built are re-read inside the copy's
        // transaction, so no reader ever sees the index lose them.
        replaceIndexContents(live, temp, () => {
          for (const file of listSessionFiles(sessionsDir))
            syncSessionFileInTransaction(live, file, "reconcile");
        });
        // Converts a legacy WAL index; any connection still open keeps it WAL until
        // a later rebuild, which writers handle either way.
        try {
          live.exec("PRAGMA journal_mode = DELETE");
        } catch (error) {
          if (!isSqliteBusy(error)) throw error;
        }
      } finally {
        live.close();
      }
    }
    return true;
  } finally {
    db?.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      rmSync(`${temp}${suffix}`, { force: true });
    release();
  }
}

// Also runs after every rebuild: a renamed-in index missed writes that failed while
// there was no valid index, and skipped transcripts are reported from here.
async function reconcile(indexPath: string, sessionsDir: string): Promise<ReindexResult> {
  const skipped = await walk(sessionsDir, (file) =>
    withSessionIndex(
      indexPath,
      { mode: "write", required: true, notifyDisabled: false },
      ({ db }) => syncSessionFileWithDb(db, file, "reconcile"),
    ),
  );
  return withSessionIndex(
    indexPath,
    { mode: "write", required: true, notifyDisabled: false },
    ({ db }) => {
      db.transaction(() => setMetadata(db, "reconciled_at", new Date().toISOString()));
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
    },
  );
}

async function walk(sessionsDir: string, sync: (file: string) => boolean): Promise<string[]> {
  const skipped: string[] = [];
  for (const file of listSessionFiles(sessionsDir)) {
    if (!sync(file)) skipped.push(file);
    await yieldToEventLoop();
  }
  return skipped;
}
