import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { HANDOFF_TOOL_DETAILS_SCHEMA } from "../../extensions/session-handoff/tool-contract.ts";
import {
  getMetadata,
  INDEX_SCHEMA_VERSION,
  initializeSchema,
  openIndexDatabase,
  type SessionIndexDatabase,
  setMetadata,
} from "../../extensions/shared/session-index/index.ts";
import { isRecord } from "../../extensions/shared/text.ts";
import { parseTypeBoxValue } from "../../extensions/shared/typebox.ts";
import {
  SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
  SUBAGENT_REPORT_MESSAGE_SCHEMA,
  SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
} from "../../extensions/subagents/ledger.ts";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const READY = Type.Object({
  sessionId: Type.String(),
  sessionFile: Type.String(),
  cwd: Type.String(),
  pid: Type.Number(),
  agentDir: Type.String(),
  packageEntry: Type.String(),
  tools: Type.Array(Type.String()),
});
const TOOL_RESULT = Type.Object({ details: Type.Optional(Type.Unknown()) });

async function waitFor<T>(
  label: string,
  probe: () => T | undefined,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

class RpcSession {
  readonly events: Record<string, unknown>[] = [];
  readonly child: ChildProcessWithoutNullStreams;
  private failure: Error | undefined;

  constructor(
    cwd: string,
    env: NodeJS.ProcessEnv,
    sessionId: string,
    log: string,
    sessionFile?: string,
  ) {
    this.child = spawn(
      "pi",
      [
        "--offline",
        "--mode",
        "rpc",
        ...(sessionFile ? ["--session", sessionFile] : ["--session-id", sessionId]),
      ],
      {
        cwd,
        env,
        stdio: "pipe",
      },
    );
    this.child.on("error", (error) => {
      this.failure = error;
    });
    this.child.stderr.on("data", (data: Buffer) => appendFileSync(`${log}.stderr`, data));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      appendFileSync(log, `${line}\n`);
      try {
        const event: unknown = JSON.parse(line);
        if (!isRecord(event)) throw new Error("Non-object RPC event");
        this.events.push(event);
        if (event.type === "extension_error") {
          this.failure = new Error(`Extension failed: ${line}`);
        }
        if (event.type === "response" && event.success === false) {
          this.failure = new Error(`RPC command failed: ${line}`);
        }
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
      }
    });
  }

  send(command: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  assertRunning(): void {
    if (this.failure) throw this.failure;
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new Error(`Pi exited: ${this.child.signalCode ?? this.child.exitCode}`);
    }
  }

  async tool(name: string, args: Record<string, unknown>, isError = false) {
    const start = this.events.length;
    this.send({ type: "prompt", message: JSON.stringify({ tool: name, args }) });
    const event = await waitFor(name, () => {
      this.assertRunning();
      return this.events
        .slice(start)
        .find((item) => item.type === "tool_execution_end" && item.toolName === name);
    });
    expect(event.isError, JSON.stringify(event)).toBe(isError);
    await waitFor(`${name} turn end`, () => {
      this.assertRunning();
      return this.events.slice(start).find((item) => item.type === "agent_end");
    });
    return parseTypeBoxValue(TOOL_RESULT, event.result, "Invalid tool result");
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    // Ending stdin shuts Pi's RPC mode down directly. A command calling ctx.shutdown() can be
    // deferred while agent_settled hooks run, after which RPC mode never checks the request.
    this.child.stdin.end();
    try {
      await waitFor("Pi shutdown", () => (this.child.exitCode !== null ? true : undefined), 5_000);
    } finally {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGKILL");
        await waitFor("Pi termination", () => (this.child.signalCode !== null ? true : undefined));
      }
    }
  }
}

test.each(["standalone", "claim", "host-tools"])("real Pi integration (%s)", async (variant) => {
  const withHost = variant !== "standalone";
  const hostTools = variant === "host-tools";
  const version = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
  const expected = JSON.parse(
    readFileSync(
      join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"),
      "utf8",
    ),
  ).version;
  expect(version, "Global Pi must match the installed development dependency").toBe(expected);
  execFileSync("tmux", ["-V"]);
  // Keep Unix socket paths short even on macOS; no contact with the user's tmux server.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ps-")));
  const artifacts = join(packageRoot, ".mise", "smoke", `${Date.now()}-${process.pid}`);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const childCwd = join(root, "other-project");
  const socket = join(root, "tmux.sock");
  const hostSocket = join(root, "host.sock");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    PI_OFFLINE: "1",
    PI_CODING_AGENT_DIR: agentDir,
    PI_SESSIONS_MESSAGING_DIR: join(root, "broker"),
    ...(withHost ? { SMOKE_HOST_SOCKET: hostSocket } : {}),
    ...(hostTools ? { SMOKE_HOST_TOOLS: "1" } : {}),
  };
  for (const directory of [agentDir, cwd, childCwd, artifacts, join(agentDir, "pi-sessions")]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [resolve(packageRoot)],
      extensions: [
        join(packageRoot, "test/smoke/install.ts"),
        join(packageRoot, "test/smoke/host-install.ts"),
      ],
      defaultProvider: "smoke",
      defaultModel: "scripted",
      defaultThinkingLevel: "off",
      sessions: {
        autoTitle: { enable: false },
        handoff: { deferred: { copyToClipboard: false } },
      },
    }),
  );
  if (!withHost) {
    // The standalone worker runs as an agent profile from Pi's default agents directory.
    mkdirSync(join(agentDir, "agents"));
    writeFileSync(
      join(agentDir, "agents", "smoke-reviewer.md"),
      [
        "---",
        "name: smoke-reviewer",
        "description: Credential-free reviewer profile.",
        "model: smoke/scripted",
        "tools: read",
        "---",
        "SMOKE_PROFILE_INSTRUCTIONS",
      ].join("\n"),
    );
    writeFileSync(join(childCwd, "AGENTS.md"), "SMOKE_PROJECT_CONTEXT\n");
  }
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
  const sessions: RpcSession[] = [];
  const hostTmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", hostSocket, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
  const parentId = randomUUID();
  const peerId = randomUUID();
  let childId: string | undefined;
  let serverStarted = false;
  let hostStarted = false;
  let passed = false;
  const errors: unknown[] = [];
  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "harness", "exec cat");
    serverStarted = true;
    tmux("set-option", "-g", "default-shell", "/bin/sh");
    env.TMUX = `${socket},${tmux("display-message", "-p", "#{pid}")},0`;
    if (withHost) {
      hostTmux("-f", "/dev/null", "new-session", "-d", "-s", "host", "exec cat");
      hostStarted = true;
      hostTmux("set-option", "-g", "default-shell", "/bin/sh");
    }
    const ready = async (id: string, rpc?: RpcSession) => {
      const file = join(agentDir, `${id}.ready.json`);
      await waitFor(`ready ${id}`, () => {
        rpc?.assertRunning();
        return existsSync(file) ? true : undefined;
      });
      const result = parseTypeBoxValue(
        READY,
        JSON.parse(readFileSync(file, "utf8")),
        "Invalid readiness",
      );
      expect(result.packageEntry).toBe(join(packageRoot, "extensions/pi-sessions.ts"));
      expect(result.agentDir).toBe(agentDir);
      expect(result.sessionFile.startsWith(`${agentDir}/sessions/`)).toBe(true);
      return result;
    };
    // Read after startup completes, not the scenario extension's earlier session_start: pi-sessions registers its
    // recall and peer tools in its own session_start, once hosts have claimed theirs.
    const startedTools = (id: string) =>
      (
        JSON.parse(readFileSync(join(agentDir, `${id}.tools.json`), "utf8")) as {
          name: string;
        }[]
      ).map((tool) => tool.name);
    const parent = new RpcSession(cwd, env, parentId, join(artifacts, "parent.jsonl"));
    sessions.push(parent);
    const parentReady = await ready(parentId, parent);
    const peer = new RpcSession(childCwd, env, peerId, join(artifacts, "peer.jsonl"));
    sessions.push(peer);
    await ready(peerId, peer);

    await parent.tool("write", { path: "fresh.txt", content: "SMOKE_FRESH_TOKEN" });
    const toolNames = startedTools(parentId);
    for (const name of ["session_search", "session_ask"]) expect(toolNames).toContain(name);
    for (const name of [
      "session_reachable",
      "session_send_message",
      "session_cancel",
      "session_handoff",
    ]) {
      expect(toolNames.includes(name)).toBe(
        name === "session_handoff" ? !withHost : !withHost || hostTools,
      );
    }
    if (hostTools) {
      expect(toolNames).toContain("session_launch");
      expect((await parent.tool("session_reachable", {})).details).toEqual({ host: "fake-host" });
    }
    for (const name of ["subagent_list", "subagent_send", "subagent_cancel", "subagent_launch"])
      expect(toolNames).toContain(name);
    const search = await peer.tool("session_search", { files: { changed: ["fresh.txt"] } });
    expect(JSON.stringify(search.details)).toContain(parentId);
    expect(readFileSync(join(cwd, "fresh.txt"), "utf8")).toBe("SMOKE_FRESH_TOKEN");
    if (!withHost) {
      const reachable = await parent.tool("session_reachable", {});
      expect(JSON.stringify(reachable.details)).toContain(peerId);
      const sent = await parent.tool("session_send_message", {
        session: peerId,
        message: "SMOKE_MESSAGE",
        requestResponse: false,
      });
      expect(sent.details).toMatchObject({ delivered: true });
    }

    const handoff = await parent.tool("subagent_launch", {
      goal: "Report SMOKE_REPORT to the parent.",
      title: "Smoke worker",
      cwd: childCwd,
      requestResponse: true,
      ...(withHost ? {} : { agent: "smoke-reviewer" }),
    });
    const receipt = parseTypeBoxValue(
      HANDOFF_TOOL_DETAILS_SCHEMA,
      handoff.details,
      "Invalid handoff",
    );
    childId = receipt.sessionId;
    if (!withHost) {
      expect(receipt.resumeCommand).toContain(
        "--approve --model 'smoke/scripted:off' --tools 'read,submit_task_report'",
      );
    }
    const childReady = await ready(receipt.sessionId);
    expect(childReady.cwd).toBe(childCwd);
    const windows = tmux("list-windows", "-a", "-F", "#{window_id}\t#{@pi_session_id}");
    const workerWindow = windows
      .split("\n")
      .find((line) => line.endsWith(`\t${receipt.sessionId}`))
      ?.split("\t")[0];
    if (!workerWindow) throw new Error(`No stamped tmux window for ${receipt.sessionId}`);
    writeFileSync(
      join(artifacts, "worker-pane.txt"),
      tmux("capture-pane", "-p", "-t", workerWindow, "-S", "-100"),
    );
    const reports = () =>
      SessionManager.open(parentReady.sessionFile)
        .getEntries()
        .filter(
          (entry) =>
            entry.type === "custom" && entry.customType === SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
        ).length;
    writeFileSync(join(agentDir, "release-worker"), "");
    await waitFor("first report", () => (reports() === 1 ? true : undefined));
    // A profiled worker's `--tools` allowlist hides every other extension tool.
    if (!withHost) expect(startedTools(receipt.sessionId)).not.toContain("session_search");
    else expect(startedTools(receipt.sessionId)).toContain("session_search");
    await waitFor("worker exit", () =>
      !tmux("list-windows", "-a", "-F", "#{@pi_session_id}").includes(receipt.sessionId)
        ? true
        : undefined,
    );
    const listed = await parent.tool("subagent_list", { scope: "tree" });
    expect(JSON.stringify(listed.details)).toContain(receipt.sessionId);
    const followup = await parent.tool("subagent_send", {
      session: receipt.sessionId,
      message: "Report SMOKE_REPORT again.",
      requestResponse: true,
    });
    expect(followup.details).toMatchObject({ delivered: true });
    await waitFor("second report", () => (reports() === 2 ? true : undefined));
    await waitFor("resumed worker exit", () =>
      !tmux("list-windows", "-a", "-F", "#{@pi_session_id}").includes(receipt.sessionId)
        ? true
        : undefined,
    );
    const resumed = await ready(receipt.sessionId);
    expect(resumed.pid).not.toBe(childReady.pid);
    const visibleReports = () =>
      SessionManager.open(parentReady.sessionFile)
        .getEntries()
        .flatMap((entry) =>
          entry.type === "custom_message" &&
          entry.customType === SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE
            ? [
                parseTypeBoxValue(
                  SUBAGENT_REPORT_MESSAGE_SCHEMA,
                  entry.details,
                  "Invalid report message",
                ),
              ]
            : [],
        );
    await waitFor("visible reports", () => (visibleReports().length >= 2 ? true : undefined));
    expect(reports()).toBe(2);
    const messages = visibleReports();
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((message) => message.reportId)).size).toBe(2);
    expect(messages.every((message) => message.provenance === "live")).toBe(true);
    if (!withHost) {
      const views = readFileSync(join(agentDir, "worker-model-view.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { systemPrompt: string; tools: string[] });
      expect(views).toHaveLength(2);
      for (const view of views) {
        expect(view.tools.sort()).toEqual(["read", "submit_task_report"]);
        expect(view.systemPrompt).toMatch(
          /<pi_sessions_subagent>\nYou are working as a subagent[^<]*\n\nSMOKE_PROFILE_INSTRUCTIONS\n<\/pi_sessions_subagent>/,
        );
        expect(view.systemPrompt).not.toContain("pi_sessions_agent_profile");
        expect(view.systemPrompt).toContain("SMOKE_PROJECT_CONTEXT");
      }
    }
    const cancelled = await parent.tool("subagent_cancel", { session: receipt.sessionId });
    expect(cancelled.details).toMatchObject({
      kind: "managed",
      accepted: true,
      state: "completed",
    });
    passed = true;
  } catch (error) {
    errors.push(error);
  } finally {
    const cleanup = async (action: () => unknown) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };
    if (!passed && serverStarted) {
      await cleanup(() => {
        const panes = tmux("list-panes", "-a", "-F", "#{pane_id}").split("\n");
        for (const pane of panes) {
          writeFileSync(
            join(artifacts, `pane-${pane.slice(1)}.txt`),
            tmux("capture-pane", "-p", "-t", pane, "-S", "-200"),
          );
        }
      });
    }
    for (const session of sessions) await cleanup(() => session.stop());
    if (serverStarted) await cleanup(() => tmux("kill-server"));
    if (hostStarted) await cleanup(() => hostTmux("kill-server"));
    await cleanup(() =>
      waitFor(
        "broker idle exit",
        () => (!existsSync(join(root, "broker/broker.pid")) ? true : undefined),
        10_000,
      ),
    );
    await cleanup(() =>
      cpSync(root, join(artifacts, "fixture"), {
        recursive: true,
        filter: (source) => !source.endsWith(".sock"),
      }),
    );
    if (!existsSync(join(root, "broker/broker.pid"))) {
      await cleanup(() => rmSync(root, { recursive: true, force: true }));
    }
    console.log(`Smoke artifacts: ${artifacts}`);
  }
  if (errors.length) {
    writeFileSync(
      join(artifacts, "failure.txt"),
      errors
        .map((error) => (error instanceof Error ? (error.stack ?? error.message) : String(error)))
        .join("\n\n"),
    );
    throw new AggregateError(errors, `Smoke failed; inspect ${root} and ${artifacts}`);
  }
  writeFileSync(
    join(artifacts, "result.json"),
    JSON.stringify(
      {
        passed: true,
        pi: version,
        checkout: resolve(packageRoot),
        parentId,
        childId,
        checks: [
          "hook freshness",
          "live discovery",
          "message delivery",
          "cross-cwd handoff",
          "real tmux stamp",
          "checkout identity",
          "report delivery",
          "dormant wake",
          "second report",
          ...(withHost ? [] : ["agent profile prompt, model, and tools across wake"]),
          ...(withHost
            ? [
                "external host enum",
                "host automatic bootstrap",
                "host dormant discovery",
                "host wake and delivery",
              ]
            : []),
          "cleanup",
        ],
      },
      null,
      2,
    ),
  );
});

test.each(["fresh", "older", "newer", "failure"])(
  "real Pi index recovery: %s",
  async (scenario) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ps-recovery-")));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const indexDir = join(agentDir, "pi-sessions");
    const indexPath = join(indexDir, "index.sqlite");
    const artifacts = join(packageRoot, ".mise/smoke", `${Date.now()}-recovery-${scenario}`);
    const sessionsDir = join(agentDir, "sessions/project");
    for (const directory of [cwd, indexDir, sessionsDir, artifacts])
      mkdirSync(directory, { recursive: true });
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      SHELL: "/bin/sh",
      PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: agentDir,
      PI_SESSIONS_MESSAGING_DIR: join(root, "broker"),
    };
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [packageRoot],
        extensions: [join(packageRoot, "test/smoke/install.ts")],
        defaultProvider: "smoke",
        defaultModel: "scripted",
        defaultThinkingLevel: "off",
        sessions: {
          search: { enable: false },
          hooks: { enable: false },
          ask: { enable: false },
          handoff: { enable: false },
          subagents: { enable: false },
          autoTitle: { enable: false },
        },
      }),
    );
    const ids = [randomUUID(), randomUUID()];
    const files = ids.map((id, i) => {
      const file = join(sessionsDir, `${id}.jsonl`);
      writeFileSync(
        file,
        `${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: new Date().toISOString() })}\n${JSON.stringify({ type: "session_info", id: `name-${i}`, parentId: null, timestamp: new Date().toISOString(), name: `Recovery peer ${i}` })}\n`,
      );
      return file;
    });
    let blocker: SessionIndexDatabase | undefined;
    if (scenario !== "fresh") {
      const db = openIndexDatabase(indexPath);
      initializeSchema(db);
      setMetadata(
        db,
        "schema_version",
        String(INDEX_SCHEMA_VERSION + (scenario === "newer" ? 1 : -1)),
      );
      db.close();
      if (scenario === "failure") {
        blocker = openIndexDatabase(indexPath, { create: false });
        blocker.exec("PRAGMA journal_mode = WAL");
        blocker.exec("BEGIN IMMEDIATE");
      }
    }
    const original = existsSync(indexPath) ? readFileSync(indexPath) : undefined;
    const originalInode = existsSync(indexPath) ? statSync(indexPath).ino : undefined;
    const publications: number[] = [];
    const watcher = watch(indexDir, (event, name) => {
      if (event === "rename" && name === "index.sqlite" && existsSync(indexPath))
        publications.push(statSync(indexPath).ino);
    });
    const sessions = ids.map(
      (id, i) => new RpcSession(cwd, env, id, join(artifacts, `pi-${i}.jsonl`), files[i]),
    );
    try {
      await Promise.all(
        ids.map((id) =>
          waitFor("Pi ready", () =>
            existsSync(join(agentDir, `${id}.ready.json`)) ? true : undefined,
          ),
        ),
      );
      for (const id of ids) {
        const ready = JSON.parse(readFileSync(join(agentDir, `${id}.ready.json`), "utf8"));
        expect(ready.tools).not.toContain("session_search");
      }
      if (scenario === "newer") {
        await Promise.all(sessions.map((session) => session.tool("session_reachable", {}, true)));
        for (const session of sessions) {
          const notices = session.events.filter(
            (event) =>
              event.type === "extension_ui_request" &&
              event.method === "notify" &&
              String(event.message).includes("pi-sessions was updated; /reload to use it"),
          );
          expect(notices).toHaveLength(1);
          expect(
            session.events.some(
              (event) =>
                event.method === "setStatus" && String(event.statusText).includes("/reload"),
            ),
          ).toBe(true);
        }
        expect(readFileSync(indexPath)).toEqual(original);
        expect(publications).toEqual([]);
      } else if (scenario === "failure") {
        const record = `${indexPath}.failure.json`;
        await waitFor("shared recovery failure", () => (existsSync(record) ? true : undefined));
        blocker?.close();
        blocker = undefined;
        const failure = JSON.parse(readFileSync(record, "utf8"));
        expect(failure.attempts).toBe(1);
        expect(failure.nextAllowedAt).toBeGreaterThan(Date.now() + 40_000);
        for (const session of sessions) {
          await session.tool("session_reachable", {}, true);
          await session.tool("session_reachable", {}, true);
        }
        expect(JSON.parse(readFileSync(record, "utf8"))).toEqual(failure);
        expect(publications).toEqual([]);
      } else {
        await waitFor("current index", () => {
          if (!existsSync(indexPath)) return undefined;
          const db = openIndexDatabase(indexPath, { create: false, mode: "read" });
          try {
            return getMetadata(db, "schema_version") === String(INDEX_SCHEMA_VERSION)
              ? true
              : undefined;
          } finally {
            db.close();
          }
        });
        const [parent, peer] = sessions;
        if (!parent || !peer) throw new Error("Missing test processes");
        await peer.tool("session_reachable", {});
        const result = await parent.tool("session_reachable", {});
        expect(JSON.stringify(result.details)).toContain(ids[1]);
        expect(JSON.stringify(result.details)).toContain("Recovery peer 1");
        if (scenario === "fresh") {
          expect(publications).toHaveLength(1);
        } else {
          // An older schema is rebuilt in place, so open connections keep the live file.
          expect(publications).toEqual([]);
          expect(statSync(indexPath).ino).toBe(originalInode);
        }
      }
    } finally {
      blocker?.close();
      watcher.close();
      for (const session of sessions) await session.stop();
      await waitFor(
        "broker exit",
        () => (!existsSync(join(root, "broker/broker.pid")) ? true : undefined),
        10_000,
      );
      cpSync(root, join(artifacts, "fixture"), {
        recursive: true,
        filter: (file) => !file.endsWith(".sock"),
      });
      rmSync(root, { recursive: true, force: true });
      console.log(`Recovery smoke artifacts: ${artifacts}`);
    }
    writeFileSync(
      join(artifacts, "result.json"),
      JSON.stringify(
        { passed: true, scenario, publications, searchEnabled: false, hooksEnabled: false },
        null,
        2,
      ),
    );
  },
);
