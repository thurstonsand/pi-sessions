import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeHerdrWorker,
  createHerdrWorker,
  type HerdrSession,
  listHerdrWorkers,
  resolveHerdrSession,
  splitHerdrPane,
} from "../extensions/shared/herdr.ts";
import { createHerdrWorkerRuntime } from "../extensions/subagents/worker-runtime.ts";

const ownerId = "12345678-1234-1234-1234-123456789abc";
const childId = "87654321-1234-1234-1234-123456789abc";

interface FakePane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  tokens?: Record<string, string>;
  label?: string;
  command?: string[];
  cwd?: string;
  input?: string[];
}

const servers: Array<{ server: Server; dir: string }> = [];

afterEach(async () => {
  for (const { server, dir } of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Herdr session resolution", () => {
  it("resolves only a pane the running Herdr knows", async () => {
    const herdr = await startHerdr([pane("w1:p1", "w1", "w1:t1")]);

    await expect(resolveHerdrSession(herdr.env("w1:p1"))).resolves.toMatchObject({
      paneId: "w1:p1",
    });
    await expect(resolveHerdrSession(herdr.env("w1:p9"))).resolves.toBeUndefined();
    await expect(
      resolveHerdrSession({ ...herdr.env("w1:p1"), HERDR_ENV: undefined }),
    ).resolves.toBeUndefined();
  });

  it("leaves a pane inherited from an exited Herdr to other backends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sessions-herdr-"));
    try {
      await expect(
        resolveHerdrSession({
          HERDR_ENV: "1",
          HERDR_SOCKET_PATH: join(dir, "gone.sock"),
          HERDR_PANE_ID: "w1:p1",
        }),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Herdr workers", () => {
  it("opens a stamped background tab in the owner's current workspace", async () => {
    // The owner's pane moved to w2 after launch, so its HERDR_WORKSPACE_ID would be stale.
    const herdr = await startHerdr([pane("w2:p1", "w2", "w2:t1", { focused: true })]);
    const session = await herdr.session("w2:p1");

    await createHerdrWorker(session, {
      ownerSessionId: ownerId,
      name: "Review parser",
      cwd: "/repo",
      command: "pi --session-id 'child' --approve",
      piSessionId: childId,
    });

    const worker = herdr.panes.find((candidate) => candidate.tokens?.pi_session_id === childId);
    expect(worker).toMatchObject({
      workspace_id: "w2",
      focused: false,
      label: "Review parser",
      cwd: "/repo",
      tokens: { pi_owner_session_id: ownerId, pi_session_id: childId },
    });
    expect(herdr.panes.find((candidate) => candidate.pane_id === "w2:p1")?.focused).toBe(true);
  });

  it("launches a worker argv that runs the shell command", async () => {
    const herdr = await startHerdr([pane("w1:p1", "w1", "w1:t1")]);
    const cwd = mkdtempSync(join(tmpdir(), "pi-sessions-herdr-worker-"));
    try {
      await createHerdrWorker(await herdr.session("w1:p1"), {
        ownerSessionId: ownerId,
        name: "Child",
        cwd,
        command: "printf %s 'pi worker' > ran",
        piSessionId: childId,
      });

      // Herdr spawns the argv directly, with no shell of its own around it.
      const [program, ...args] = herdr.panes.at(-1)?.command ?? [];
      const run = spawnSync(program ?? "", args, { cwd, encoding: "utf8" });
      expect(run.error).toBeUndefined();
      expect(readFileSync(join(cwd, "ran"), "utf8")).toBe("pi worker");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps one pane per child when created twice", async () => {
    const herdr = await startHerdr([pane("w1:p1", "w1", "w1:t1")]);
    const session = await herdr.session("w1:p1");
    const options = { ownerSessionId: ownerId, name: "Child", cwd: "/repo", command: "pi" };

    await Promise.all([
      createHerdrWorker(session, { ...options, piSessionId: childId }),
      createHerdrWorker(session, { ...options, piSessionId: childId }),
    ]);

    expect(await listHerdrWorkers(session.client, ownerId)).toHaveLength(1);
  });

  it("lists only the owner's stamped workers", async () => {
    const herdr = await startHerdr([
      pane("w1:p1", "w1", "w1:t1"),
      pane("w1:p2", "w1", "w1:t2", {
        tokens: { pi_owner_session_id: ownerId, pi_session_id: childId },
      }),
      pane("w1:p3", "w1", "w1:t3", {
        tokens: { pi_owner_session_id: "other-owner", pi_session_id: "other-child" },
      }),
      pane("w1:p4", "w1", "w1:t4", { tokens: { pi_owner_session_id: ownerId } }),
    ]);
    const session = await herdr.session("w1:p1");

    await expect(listHerdrWorkers(session.client, ownerId)).resolves.toEqual([
      { paneId: "w1:p2", tabId: "w1:t2", focused: false, piSessionId: childId },
    ]);
  });

  it("closes a worker whose stamp failed instead of leaving it unowned", async () => {
    const herdr = await startHerdr([pane("w1:p1", "w1", "w1:t1")], {
      failMethod: "pane.report_metadata",
    });
    const session = await herdr.session("w1:p1");

    await expect(
      createHerdrWorker(session, {
        ownerSessionId: ownerId,
        name: "Child",
        cwd: "/repo",
        command: "pi",
        piSessionId: childId,
      }),
    ).rejects.toThrow("Herdr pane.report_metadata failed");
    expect(herdr.panes.map((candidate) => candidate.pane_id)).toEqual(["w1:p1"]);
  });

  it("treats a worker that already exited as stopped", async () => {
    const herdr = await startHerdr(
      [
        pane("w1:p1", "w1", "w1:t1"),
        pane("w1:p2", "w1", "w1:t2", {
          tokens: { pi_owner_session_id: ownerId, pi_session_id: childId },
        }),
      ],
      { exitBeforeClose: true },
    );
    const session = await herdr.session("w1:p1");

    await expect(closeHerdrWorker(session.client, ownerId, childId)).resolves.toBe(true);
  });

  it("is watched only while the worker's own pane is focused", async () => {
    const herdr = await startHerdr([
      pane("w1:p1", "w1", "w1:t1"),
      pane("w1:p2", "w1", "w1:t2", {
        focused: true,
        tokens: { pi_owner_session_id: ownerId, pi_session_id: "sibling" },
      }),
      pane("w1:p3", "w1", "w1:t3", {
        tokens: { pi_owner_session_id: ownerId, pi_session_id: childId },
      }),
    ]);
    const runtime = createHerdrWorkerRuntime(await herdr.session("w1:p1"));

    await expect(runtime.isWatched(ownerId, childId)).resolves.toBe(false);
    await expect(runtime.isWatched(ownerId, "sibling")).resolves.toBe(true);
    await expect(runtime.list(ownerId)).resolves.toContainEqual({
      piSessionId: childId,
      observeCommand: "herdr tab focus 'w1:t3'",
    });
  });
});

describe("Herdr split handoff", () => {
  it.each([
    { direction: "right", order: ["w1:p1", "w1:p2"] },
    { direction: "left", order: ["w1:p2", "w1:p1"] },
  ] as const)("opens a $direction split that runs the command", async ({ direction, order }) => {
    const herdr = await startHerdr([pane("w1:p1", "w1", "w1:t1", { focused: true })]);

    await splitHerdrPane(await herdr.session("w1:p1"), {
      direction,
      cwd: "/repo",
      command: "pi --session-id 'child'",
    });

    expect(herdr.panes.map((candidate) => candidate.pane_id)).toEqual(order);
    expect(herdr.panes.find((candidate) => candidate.pane_id === "w1:p2")).toMatchObject({
      cwd: "/repo",
      input: ["pi --session-id 'child'", "Enter"],
    });
    expect(herdr.panes.find((candidate) => candidate.focused)?.pane_id).toBe("w1:p1");
  });
});

function pane(
  paneId: string,
  workspaceId: string,
  tabId: string,
  extra: Partial<FakePane> = {},
): FakePane {
  return { pane_id: paneId, workspace_id: workspaceId, tab_id: tabId, focused: false, ...extra };
}

/** A Herdr server reduced to the pane model pi-sessions relies on. */
async function startHerdr(
  initial: FakePane[],
  options: { failMethod?: string; exitBeforeClose?: boolean } = {},
) {
  const panes = [...initial];
  let nextPane = panes.length + 1;
  const find = (paneId: unknown) => panes.find((candidate) => candidate.pane_id === paneId);
  const notFound = (paneId: unknown) => ({
    error: { code: "pane_not_found", message: `pane ${String(paneId)} not found` },
  });

  const handle = (method: string, params: Record<string, unknown>) => {
    if (method === options.failMethod) {
      return { error: { code: "internal", message: "refused" } };
    }
    switch (method) {
      case "pane.get": {
        const found = find(params.pane_id);
        return found ? { result: { type: "pane_info", pane: found } } : notFound(params.pane_id);
      }
      case "pane.list":
        return { result: { type: "pane_list", panes } };
      case "layout.apply": {
        const root = params.root as { label: string; cwd: string; command: string[] };
        const tabId = `${String(params.workspace_id)}:t${nextPane}`;
        const created = pane(
          `${String(params.workspace_id)}:p${nextPane}`,
          String(params.workspace_id),
          tabId,
          {
            label: root.label,
            cwd: root.cwd,
            command: root.command,
            focused: params.focus === true,
          },
        );
        nextPane += 1;
        panes.push(created);
        return {
          result: {
            type: "layout_apply",
            layout: { tab_id: tabId, root: { type: "pane", pane_id: created.pane_id } },
          },
        };
      }
      case "pane.report_metadata": {
        const found = find(params.pane_id);
        if (!found) return notFound(params.pane_id);
        found.tokens = { ...found.tokens, ...(params.tokens as Record<string, string>) };
        return { result: { type: "ok" } };
      }
      case "pane.close": {
        const index = panes.findIndex((candidate) => candidate.pane_id === params.pane_id);
        if (index === -1 || options.exitBeforeClose) {
          if (index !== -1) panes.splice(index, 1);
          return notFound(params.pane_id);
        }
        panes.splice(index, 1);
        return { result: { type: "ok" } };
      }
      case "pane.split": {
        const target = find(params.target_pane_id);
        if (!target) return notFound(params.target_pane_id);
        const created = pane(
          `${target.workspace_id}:p${nextPane}`,
          target.workspace_id,
          target.tab_id,
          {
            cwd: String(params.cwd),
            focused: params.focus === true,
          },
        );
        nextPane += 1;
        panes.splice(panes.indexOf(target) + 1, 0, created);
        return { result: { type: "pane_info", pane: created } };
      }
      case "pane.swap": {
        const source = find(params.source_pane_id);
        const target = find(params.target_pane_id);
        if (!source || !target) return notFound(params.source_pane_id);
        const sourceIndex = panes.indexOf(source);
        const targetIndex = panes.indexOf(target);
        panes[sourceIndex] = target;
        panes[targetIndex] = source;
        for (const candidate of panes) candidate.focused = candidate === source;
        return { result: { type: "pane_swap" } };
      }
      case "pane.send_input": {
        const found = find(params.pane_id);
        if (!found) return notFound(params.pane_id);
        found.input = [String(params.text), ...(params.keys as string[])];
        return { result: { type: "ok" } };
      }
      default:
        return { error: { code: "unknown_method", message: method } };
    }
  };

  const dir = mkdtempSync(join(tmpdir(), "pi-sessions-herdr-"));
  const socketPath = join(dir, "herdr.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      const request = JSON.parse(buffer.slice(0, end)) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      socket.end(
        `${JSON.stringify({ id: request.id, ...handle(request.method, request.params) })}\n`,
      );
    });
  });
  // Herdr on Windows claims the socket path with a plain file and listens on the named pipe beside it.
  if (process.platform === "win32") {
    writeFileSync(socketPath, "");
  }
  const listenPath = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  await new Promise<void>((resolve) => server.listen(listenPath, resolve));
  servers.push({ server, dir });

  const env = (paneId: string) => ({
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PANE_ID: paneId,
  });
  return {
    panes,
    env,
    async session(paneId: string): Promise<HerdrSession> {
      const session = await resolveHerdrSession(env(paneId));
      if (!session) throw new Error(`Fake Herdr does not know ${paneId}.`);
      return session;
    },
  };
}
