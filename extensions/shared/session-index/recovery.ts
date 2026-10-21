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

// Serializes rebuilds only; ordinary writers rely on SQLite's own write lock.
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
  try {
    const failure = readIndexRecoveryFailure(indexPath);
    // Read-only, so a writer cannot stall it; rebuild re-probes authoritatively.
    const state = probeIndex(indexPath, "read");
    if (state === "newer") {
      disableOlderIndexClient(indexPath);
      return undefined;
    }
    if (!manual && failure && Date.now() < failure.nextAllowedAt) {
      report(indexPath, getIndexRecoveryMessage(indexPath) ?? failure.error);
      return undefined;
    }
    if (state === "current" && !manual && !reconcileRequested) {
      if (!failure) notices.get(indexPath)?.(undefined);
      return undefined;
    }
    if ((manual || state !== "current") && !(await rebuild(indexPath, sessionsDir, manual)))
      return undefined;
    const result = await reconcile(indexPath, sessionsDir);
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
    report(indexPath, getIndexRecoveryMessage(indexPath) ?? failure.error);
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
    withSessionIndex(indexPath, { mode: "write", required: true }, ({ db }) =>
      syncSessionFileWithDb(db, file, "reconcile"),
    ),
  );
  return withSessionIndex(indexPath, { mode: "write", required: true }, ({ db }) => {
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
  });
}

async function walk(sessionsDir: string, sync: (file: string) => boolean): Promise<string[]> {
  const skipped: string[] = [];
  for (const file of listSessionFiles(sessionsDir)) {
    if (!sync(file)) skipped.push(file);
    await yieldToEventLoop();
  }
  return skipped;
}
