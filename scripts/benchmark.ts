import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    sessions: { type: "string" },
    count: { type: "string", default: "100" },
    entries: { type: "string", default: "100" },
    samples: { type: "string", default: "10" },
    output: { type: "string" },
  },
});
function positiveInteger(raw: string, name: string): number {
  const value = Number(raw);
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}
const samples = positiveInteger(values.samples, "samples");
const root = mkdtempSync(join(tmpdir(), "ps-bench-"));
const sessionsDir = values.sessions ? resolve(values.sessions) : join(root, "agent", "sessions");
const agentDir = dirname(sessionsDir);
const output = resolve(values.output ?? `.mise/benchmarks/${Date.now()}.json`);

function distribution(milliseconds: number[]) {
  const sorted = [...milliseconds].sort((a, b) => a - b);
  return {
    samplesMs: milliseconds,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

try {
  assert(
    basename(sessionsDir) === "sessions",
    "--sessions must name a Pi agent's sessions directory",
  );
  // Reindex only reads transcripts. Keep original paths so parent/child links remain faithful.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SESSIONS_MESSAGING_DIR = join(root, "broker");
  process.env.PI_OFFLINE = "1";
  const { listSessionFiles } = await import("../extensions/session-search/extract.ts");
  const { rebuildSessionIndex } = await import("../extensions/session-search/reindex.ts");
  const { createSessionHookController } = await import("../extensions/session-search/hooks.ts");
  const { openIndexDatabase, searchSessions } = await import(
    "../extensions/shared/session-index/index.ts"
  );
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");

  if (values.sessions) {
    assert(statSync(sessionsDir).isDirectory(), "--sessions must be a directory");
  } else {
    mkdirSync(sessionsDir, { recursive: true });
    const count = positiveInteger(values.count, "count");
    const entries = positiveInteger(values.entries, "entries");
    const directory = join(sessionsDir, "--benchmark--");
    mkdirSync(directory);
    const timestamp = "2026-01-01T00:00:00.000Z";
    for (let session = 0; session < count; session++) {
      const id = `00000000-0000-4000-8000-${String(session).padStart(12, "0")}`;
      const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: root })];
      for (let entry = 0; entry < entries; entry++) {
        lines.push(
          JSON.stringify({
            type: "message",
            id: `e${entry}`,
            parentId: entry ? `e${entry - 1}` : null,
            timestamp,
            message: {
              role: "user",
              timestamp: Date.parse(timestamp),
              content: `Session ${session} entry ${entry}: ${entry % 5 ? "session index" : "tmux subagent"}. ${"Representative transcript text. ".repeat(32)}`,
            },
          }),
        );
      }
      writeFileSync(join(directory, `${id}.jsonl`), `${lines.join("\n")}\n`);
    }
  }
  const files = listSessionFiles(sessionsDir);
  assert(files.length > 0, "The corpus contains no JSONL sessions");
  const manifest = files.map((file) => ({
    file: relative(sessionsDir, file),
    bytes: statSync(file).size,
  }));
  const largest = [...files].sort((a, b) => statSync(b).size - statSync(a).size)[0];
  assert(largest);

  const indexPath = join(root, "index.sqlite");
  const start = performance.now();
  const rebuilt = await rebuildSessionIndex({ indexPath });
  const rebuildMs = performance.now() - start;
  const rebuildPeakRssMiB = process.resourceUsage().maxRSS / 1024;
  assert(rebuilt.sessionCount > 0, "Rebuild indexed no sessions");
  const indexBytes = statSync(indexPath).size;
  const db = openIndexDatabase(indexPath, { create: false });
  try {
    const searches = [
      undefined,
      "session",
      '"session index"',
      "tmux subagent",
      "zz_benchmark_absent_82917",
    ].map((query) => {
      const times: number[] = [];
      let sessionIds: string[] = [];
      for (let i = 0; i <= samples; i++) {
        const started = performance.now();
        const hits = searchSessions(db, { query, limit: 10 });
        times.push(performance.now() - started);
        const ids = hits.map((hit) => hit.sessionId);
        if (i > 0) assert.deepEqual(ids, sessionIds, "Search results changed between samples");
        sessionIds = ids;
      }
      const firstMs = times.shift();
      return {
        query: query ?? null,
        hits: sessionIds.length,
        resultIdsHash: createHash("sha256").update(JSON.stringify(sessionIds)).digest("hex"),
        firstMs,
        ...distribution(times),
      };
    });
    const writableSession = join(root, "incremental.jsonl");
    copyFileSync(largest, writableSession, constants.COPYFILE_FICLONE);
    const manager = SessionManager.open(writableSession);
    const controller = createSessionHookController({ indexPath });
    const attachStart = performance.now();
    await controller.handleSessionStart(largest, manager.getCwd());
    const attachMs = performance.now() - attachStart;
    await controller.handleSessionStart(writableSession, manager.getCwd());
    let parentId = manager.getLeafId();
    const incremental: number[] = [];
    for (let i = 0; i < samples; i++) {
      const id = `benchmark-${i}`;
      appendFileSync(
        writableSession,
        `${JSON.stringify({
          type: "message",
          id,
          parentId,
          timestamp: new Date().toISOString(),
          message: {
            role: "user",
            content: `BENCHMARK_INCREMENTAL_TOKEN_${i}`,
            timestamp: Date.now(),
          },
        })}\n`,
      );
      parentId = id;
      const started = performance.now();
      assert(
        await controller.handleTurnEnd(writableSession, manager.getCwd()),
        "Incremental flush did not run",
      );
      incremental.push(performance.now() - started);
      assert(
        searchSessions(db, { query: `"BENCHMARK_INCREMENTAL_TOKEN_${i}"`, limit: 10 }).some(
          (hit) => hit.sessionId === manager.getSessionId(),
        ),
        "Appended text is not searchable",
      );
    }
    const report = {
      timestamp: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      corpus: {
        kind: values.sessions ? "local-read-only" : "synthetic",
        files: files.length,
        bytes: manifest.reduce((sum, entry) => sum + entry.bytes, 0),
        manifestHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
        largestBytes: Math.max(...manifest.map((entry) => entry.bytes)),
      },
      cache:
        "Fresh database; filesystem cache is not flushed. Each search has one first call, then warm samples.",
      rebuild: {
        milliseconds: rebuildMs,
        peakRssMiB: rebuildPeakRssMiB,
        sessions: rebuilt.sessionCount,
        chunks: rebuilt.chunkCount,
        indexBytes,
      },
      searches,
      incremental: { attachMs, ...distribution(incremental) },
    };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    console.log(`Benchmark artifact: ${output}`);
  } finally {
    db.close();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
