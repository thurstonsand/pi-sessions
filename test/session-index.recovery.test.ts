import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  getMetadata,
  INDEX_SCHEMA_VERSION,
  openIndexDatabase,
  searchSessions,
  setMetadata,
  withSessionIndex,
} from "../extensions/shared/session-index/index.ts";
import {
  acquireIndexLock,
  observeIndexRecovery,
  readIndexRecoveryFailure,
  rebuildSessionIndex,
  requestIndexRecovery,
} from "../extensions/shared/session-index/recovery.ts";
import { createSessionHookController } from "../extensions/shared/session-index/sync.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const fs = createTestFilesystem("pi-index-recovery-");
afterEach(() => {
  vi.unstubAllEnvs();
  fs.cleanup();
});

function fixture() {
  const root = fs.createTempDir();
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  const file = fs.writeJsonlFile(path.join(root, "sessions", "project"), "valid.jsonl", [
    { type: "session", id: "prior", timestamp: "2026-10-09T00:00:00Z", cwd: root },
    {
      type: "message",
      id: "prompt",
      parentId: null,
      timestamp: "2026-10-09T00:00:01Z",
      message: { role: "user", content: "recoverable evidence" },
    },
  ]);
  const indexPath = path.join(root, "index.sqlite");
  const notices: string[] = [];
  observeIndexRecovery(indexPath, (message) => {
    if (message) notices.push(message);
  });
  return { root, file, indexPath, notices };
}

function appendTurn(file: string, text: string) {
  appendFileSync(
    file,
    `${JSON.stringify({
      type: "message",
      id: `turn-${text}`,
      parentId: "prompt",
      timestamp: "2026-10-09T00:00:02Z",
      message: { role: "user", content: text },
    })}\n`,
  );
}

function chunkCount(indexPath: string, text: string) {
  return withSessionIndex(indexPath, { mode: "read", required: true }, ({ db }) =>
    db.prepare("SELECT COUNT(*) AS count FROM session_text_chunks WHERE text = ?").get(text),
  );
}

function search(indexPath: string) {
  return withSessionIndex(indexPath, { mode: "read", required: true }, ({ db }) =>
    searchSessions(db, {}),
  );
}

it("recovers on demand, skips broken transcripts, and reconciles drift without rebuilding current rows", async () => {
  const { root, file, indexPath, notices } = fixture();
  const broken = path.join(root, "sessions/project/broken.jsonl");
  writeFileSync(broken, '{"type":"session","id":"broken"}\n{"type":"message","message":null}\n');
  expect(() => search(indexPath)).toThrow("indexing in progress");
  expect(
    withSessionIndex(indexPath, { mode: "write", required: false }, () => true),
  ).toBeUndefined();
  await requestIndexRecovery(indexPath);
  expect(search(indexPath).map((session) => session.sessionId)).toEqual(["prior"]);
  expect(notices.join("\n")).toContain(broken);
  const inode = statSync(indexPath).ino;
  withSessionIndex(indexPath, { mode: "write", required: true }, ({ db }) => {
    db.prepare("UPDATE sessions SET index_source = 'unchanged'").run();
  });
  fs.writeJsonlFile(path.dirname(file), "drift.jsonl", [
    { type: "session", id: "drift", timestamp: "2026-10-09T01:00:00Z", cwd: root },
  ]);
  await requestIndexRecovery(indexPath, true);
  expect(search(indexPath).map((session) => session.sessionId)).toEqual(["drift", "prior"]);
  expect(statSync(indexPath).ino).toBe(inode);
  expect(
    withSessionIndex(indexPath, { mode: "read", required: true }, ({ db }) =>
      db.prepare("SELECT index_source FROM sessions WHERE session_id = 'prior'").get(),
    ),
  ).toEqual({ index_source: "unchanged" });
});

it("moves unreadable databases aside and rebuilds older schemas in place", async () => {
  const { root, indexPath } = fixture();
  writeFileSync(indexPath, "broken database");
  expect(() => search(indexPath)).toThrow("indexing");
  await requestIndexRecovery(indexPath);
  expect(search(indexPath)).toHaveLength(1);
  const backup = readdirSync(root).find((file) => file.startsWith("index.sqlite.bad-"));
  expect(backup).toBeDefined();
  expect(readFileSync(path.join(root, backup ?? ""), "utf8")).toBe("broken database");
  withSessionIndex(indexPath, { mode: "write", required: true }, ({ db }) =>
    setMetadata(db, "schema_version", String(INDEX_SCHEMA_VERSION - 1)),
  );
  const inode = statSync(indexPath).ino;
  await Promise.all([requestIndexRecovery(indexPath), requestIndexRecovery(indexPath)]);
  expect(statSync(indexPath).ino).toBe(inode);
  expect(
    withSessionIndex(
      indexPath,
      { mode: "read", required: true },
      ({ status }) => status.schemaVersion,
    ),
  ).toBe(INDEX_SCHEMA_VERSION);
  const indexedAt = () =>
    withSessionIndex(indexPath, { mode: "read", required: true }, ({ db }) =>
      getMetadata(db, "indexed_at"),
    );
  const rebuiltAt = indexedAt();
  await requestIndexRecovery(indexPath);
  expect(indexedAt()).toBe(rebuiltAt);
  expect(search(indexPath)).toHaveLength(1);
});

it("disables an older client without reading or changing newer-schema contents, including manual rebuild", async () => {
  const { indexPath, notices } = fixture();
  await rebuildSessionIndex({ indexPath });
  withSessionIndex(indexPath, { mode: "write", required: true }, ({ db }) =>
    setMetadata(db, "schema_version", String(INDEX_SCHEMA_VERSION + 1)),
  );
  const before = readFileSync(indexPath);
  expect(() => search(indexPath)).toThrow("pi-sessions was updated; /reload to use it");
  expect(
    withSessionIndex(indexPath, { mode: "write", required: false }, () => {
      throw new Error("must not execute");
    }),
  ).toBeUndefined();
  await expect(rebuildSessionIndex({ indexPath })).rejects.toThrow("/reload");
  expect(notices).toEqual(["pi-sessions was updated; /reload to use it"]);
  expect(readFileSync(indexPath)).toEqual(before);
});

it("persists failure backoff and lets a manual rebuild bypass it without destroying a readable index", async () => {
  const { indexPath, notices } = fixture();
  await rebuildSessionIndex({ indexPath });
  // Fail publication after the temporary database has been built.
  const blocker = openIndexDatabase(indexPath, { create: false });
  blocker.exec("PRAGMA journal_mode = WAL");
  blocker.exec("BEGIN IMMEDIATE");
  try {
    await expect(rebuildSessionIndex({ indexPath })).rejects.toThrow();
  } finally {
    blocker.close();
  }
  const first = readIndexRecoveryFailure(indexPath);
  expect(first).toMatchObject({
    attempts: 1,
    build: expect.stringMatching(/^index-v/),
    error: expect.any(String),
  });
  expect(first?.nextAllowedAt).toBeGreaterThan(Date.now() + 50_000);
  expect(search(indexPath)).toHaveLength(1);
  await requestIndexRecovery(indexPath, true);
  await requestIndexRecovery(indexPath, true);
  expect(readIndexRecoveryFailure(indexPath)).toEqual(first);
  expect(notices.filter((message) => message.includes("failed"))).toHaveLength(1);
  for (const [attempts, waitMs] of [
    [2, 300_000],
    [3, 1_800_000],
    [4, 1_800_000],
  ] as const) {
    const blocker = openIndexDatabase(indexPath, { create: false });
    blocker.exec("PRAGMA journal_mode = WAL");
    blocker.exec("BEGIN IMMEDIATE");
    const started = Date.now();
    try {
      await expect(rebuildSessionIndex({ indexPath })).rejects.toThrow();
    } finally {
      blocker.close();
    }
    const failure = readIndexRecoveryFailure(indexPath);
    expect(failure?.attempts).toBe(attempts);
    expect(failure?.nextAllowedAt).toBeGreaterThanOrEqual(started + waitMs);
    expect(failure?.nextAllowedAt).toBeLessThanOrEqual(Date.now() + waitMs);
  }
  await rebuildSessionIndex({ indexPath });
  expect(existsSync(`${indexPath}.failure.json`)).toBe(false);
  expect(search(indexPath)).toHaveLength(1);
  const db = openIndexDatabase(indexPath, { create: false, mode: "read" });
  expect(getMetadata(db, "schema_version")).toBe(String(INDEX_SCHEMA_VERSION));
  db.close();
  // Each of the five injected failures waits out the publish copy's 5 s busy_timeout.
}, 40_000);

it("lands hook writes while a rebuilder holds the rebuild lock", async () => {
  const { file, indexPath } = fixture();
  await rebuildSessionIndex({ indexPath });
  const controller = createSessionHookController({ indexPath });
  appendTurn(file, "written under the rebuild lock");
  const release = acquireIndexLock(indexPath);
  expect(release).toBeDefined();
  try {
    expect(await controller.handleTurnEnd(file)).toBe(true);
  } finally {
    release?.();
  }
  expect(chunkCount(indexPath, "written under the rebuild lock")).toEqual({ count: 1 });
});

it("lands hook writes into a WAL index another connection holds open", async () => {
  const { file, indexPath } = fixture();
  await rebuildSessionIndex({ indexPath });
  const legacy = openIndexDatabase(indexPath, { create: false });
  try {
    legacy.exec("PRAGMA journal_mode = WAL");
    legacy.exec("BEGIN");
    legacy.prepare("SELECT COUNT(*) FROM sessions").get();
    appendTurn(file, "written beside a WAL reader");
    expect(await createSessionHookController({ indexPath }).handleTurnEnd(file)).toBe(true);
    legacy.exec("COMMIT");
  } finally {
    legacy.close();
  }
  expect(chunkCount(indexPath, "written beside a WAL reader")).toEqual({ count: 1 });
});

it("waits out another process's rebuild past busy_timeout, then lands the hook write", async () => {
  const { file, indexPath } = fixture();
  await rebuildSessionIndex({ indexPath });
  const rebuilder = spawn(
    process.execPath,
    [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
      const lock = new DatabaseSync(process.argv[1] + ".lock.sqlite");
      lock.exec("BEGIN EXCLUSIVE");
      const index = new DatabaseSync(process.argv[1]);
      index.exec("BEGIN IMMEDIATE");
      console.log("held");
      setTimeout(() => { index.exec("ROLLBACK"); lock.close(); }, 6_000);`,
      indexPath,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = new Promise((resolve) => rebuilder.on("exit", resolve));
  await new Promise((resolve) => rebuilder.stdout.once("data", resolve));
  appendTurn(file, "written after a foreign rebuild");
  const started = Date.now();
  expect(await createSessionHookController({ indexPath }).handleTurnEnd(file)).toBe(true);
  expect(Date.now() - started).toBeGreaterThan(5_500);
  await exited;
  expect(chunkCount(indexPath, "written after a foreign rebuild")).toEqual({ count: 1 });
}, 20_000);

it("keeps connections opened before a rebuild writing into the live index", async () => {
  const { indexPath } = fixture();
  await rebuildSessionIndex({ indexPath });
  const early = openIndexDatabase(indexPath, { create: false });
  try {
    await rebuildSessionIndex({ indexPath });
    early.transaction(() => setMetadata(early, "early_writer", "landed"));
  } finally {
    early.close();
  }
  expect(existsSync(`${indexPath}-journal`)).toBe(false);
  withSessionIndex(indexPath, { mode: "read", required: true }, ({ db }) => {
    expect(getMetadata(db, "early_writer")).toBe("landed");
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
});

it("indexes a turn_end that interleaves with a reconcile exactly once", async () => {
  const { root, file, indexPath } = fixture();
  for (let i = 0; i < 20; i++)
    fs.writeJsonlFile(path.join(root, "sessions", "project"), `extra-${i}.jsonl`, [
      { type: "session", id: `extra-${i}`, timestamp: "2026-10-09T00:00:00Z", cwd: root },
    ]);
  await rebuildSessionIndex({ indexPath });
  const controller = createSessionHookController({ indexPath });
  appendTurn(file, "interleaved with reconcile");
  const reconciling = requestIndexRecovery(indexPath, true);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  const synced = controller.handleTurnEnd(file);
  await expect(Promise.all([synced, reconciling])).resolves.toEqual([
    true,
    expect.objectContaining({ sessionCount: 21 }),
  ]);
  expect(chunkCount(indexPath, "interleaved with reconcile")).toEqual({ count: 1 });
});

it("never shows a reader the index without writes acknowledged during a rebuild", async () => {
  const { root, file, indexPath } = fixture();
  const files = [file];
  for (let i = 0; i < 20; i++)
    files.push(
      fs.writeJsonlFile(path.join(root, "sessions", "project"), `extra-${i}.jsonl`, [
        { type: "session", id: `extra-${i}`, timestamp: "2026-10-09T00:00:00Z", cwd: root },
        {
          type: "message",
          id: "prompt",
          parentId: null,
          timestamp: "2026-10-09T00:00:01Z",
          message: { role: "user", content: `extra prompt ${i}` },
        },
      ]),
    );
  await rebuildSessionIndex({ indexPath });
  const controller = createSessionHookController({ indexPath });
  let settled = false;
  const rebuilding = rebuildSessionIndex({ indexPath }).finally(() => {
    settled = true;
  });
  const acknowledged: string[] = [];
  const missing = new Set<string>();
  for (let tick = 0; !settled; tick++) {
    await new Promise((resolve) => setImmediate(resolve));
    // Check before writing: a hook's tail sync would otherwise re-read lost turns first.
    withSessionIndex(indexPath, { mode: "read", required: true }, ({ db }) => {
      const present = new Set(
        db
          .prepare("SELECT text FROM session_text_chunks WHERE text LIKE 'tick %'")
          .all()
          .map((row) => String((row as { text: string }).text)),
      );
      for (const text of acknowledged) if (!present.has(text)) missing.add(text);
    });
    for (const [i, target] of files.entries()) {
      const text = `tick ${tick} file ${i}`;
      appendTurn(target, text);
      expect(await controller.handleTurnEnd(target)).toBe(true);
      acknowledged.push(text);
    }
  }
  await rebuilding;
  expect(acknowledged.length).toBeGreaterThan(files.length);
  expect([...missing]).toEqual([]);
});
