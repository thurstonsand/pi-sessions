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
  initializeSchema,
  openIndexDatabase,
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
  provider: Type.Literal("smoke"),
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

  constructor(cwd: string, env: NodeJS.ProcessEnv, sessionId: string, log: string) {
    this.child = spawn("pi", ["--offline", "--mode", "rpc", "--session-id", sessionId], {
      cwd,
      env,
      stdio: "pipe",
    });
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

  async tool(name: string, args: Record<string, unknown>) {
    const start = this.events.length;
    this.send({ type: "prompt", message: JSON.stringify({ tool: name, args }) });
    const event = await waitFor(name, () => {
      this.assertRunning();
      return this.events
        .slice(start)
        .find((item) => item.type === "tool_execution_end" && item.toolName === name);
    });
    expect(event.isError, JSON.stringify(event)).toBe(false);
    await waitFor(`${name} turn end`, () => {
      this.assertRunning();
      return this.events.slice(start).find((item) => item.type === "agent_end");
    });
    return parseTypeBoxValue(TOOL_RESULT, event.result, "Invalid tool result");
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.send({ type: "prompt", message: "/smoke-quit" });
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

test("isolated real Pi: hooks, discovery, handoff, report, dormant wake and checkout identity", async () => {
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
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    PI_OFFLINE: "1",
    PI_CODING_AGENT_DIR: agentDir,
    PI_SESSIONS_MESSAGING_DIR: join(root, "broker"),
  };
  for (const directory of [agentDir, cwd, childCwd, artifacts, join(agentDir, "pi-sessions")]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [resolve(packageRoot)],
      extensions: [join(packageRoot, "test/smoke/install.ts")],
      defaultProvider: "smoke",
      defaultModel: "scripted",
      defaultThinkingLevel: "off",
      sessions: { autoTitle: { enable: false }, handoff: { deferred: { copyToClipboard: false } } },
    }),
  );
  const db = openIndexDatabase(join(agentDir, "pi-sessions/index.sqlite"));
  initializeSchema(db);
  db.close();
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
  const sessions: RpcSession[] = [];
  const parentId = randomUUID();
  const peerId = randomUUID();
  let childId: string | undefined;
  let serverStarted = false;
  let passed = false;
  const errors: unknown[] = [];
  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "harness", "exec cat");
    serverStarted = true;
    tmux("set-option", "-g", "default-shell", "/bin/sh");
    env.TMUX = `${socket},${tmux("display-message", "-p", "#{pid}")},0`;
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
      expect(result.tools).toContain("session_search");
      return result;
    };
    const parent = new RpcSession(cwd, env, parentId, join(artifacts, "parent.jsonl"));
    sessions.push(parent);
    const parentReady = await ready(parentId, parent);
    const peer = new RpcSession(childCwd, env, peerId, join(artifacts, "peer.jsonl"));
    sessions.push(peer);
    await ready(peerId, peer);

    await parent.tool("write", { path: "fresh.txt", content: "SMOKE_FRESH_TOKEN" });
    const search = await peer.tool("session_search", { files: { changed: ["fresh.txt"] } });
    expect(JSON.stringify(search.details)).toContain(parentId);
    expect(readFileSync(join(cwd, "fresh.txt"), "utf8")).toBe("SMOKE_FRESH_TOKEN");
    const reachable = await parent.tool("session_reachable", { scope: "user" });
    expect(JSON.stringify(reachable.details)).toContain(peerId);
    const sent = await parent.tool("session_send_message", {
      session: peerId,
      message: "SMOKE_MESSAGE",
      requestResponse: false,
    });
    expect(sent.details).toMatchObject({ delivered: true });

    const handoff = await parent.tool("session_handoff", {
      goal: "Report SMOKE_REPORT to the parent.",
      title: "Smoke worker",
      launch: "subagent",
      cwd: childCwd,
    });
    const receipt = parseTypeBoxValue(
      HANDOFF_TOOL_DETAILS_SCHEMA,
      handoff.details,
      "Invalid handoff",
    );
    childId = receipt.sessionId;
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
    await waitFor("worker exit", () =>
      !tmux("list-windows", "-a", "-F", "#{@pi_session_id}").includes(receipt.sessionId)
        ? true
        : undefined,
    );
    const followup = await parent.tool("session_send_message", {
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
          "cleanup",
        ],
      },
      null,
      2,
    ),
  );
});
