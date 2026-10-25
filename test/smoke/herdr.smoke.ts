import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { shellQuote } from "../../extensions/session-handoff/launch/shell.ts";
import {
  closeHerdrWorker,
  createHerdrWorker,
  listHerdrWorkers,
  resolveHerdrSession,
} from "../../extensions/shared/herdr.ts";
import { parseTypeBoxValue } from "../../extensions/shared/typebox.ts";

const WORKSPACE_CREATED = Type.Object({
  result: Type.Object({ root_pane: Type.Object({ pane_id: Type.String() }) }),
});

test("drives a real headless Herdr: resolves its pane and runs a stamped worker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sessions-herdr-smoke-"));
  // The caller may itself run inside Herdr; none of its pane identity may leak into this server.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")),
  );
  env.XDG_CONFIG_HOME = join(dir, "config");
  env.XDG_STATE_HOME = join(dir, "state");
  env.HERDR_SOCKET_PATH = join(dir, "herdr.sock");
  const herdr = (...args: string[]) =>
    execFileSync("herdr", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  let server: ChildProcess | undefined;
  try {
    server = spawn("herdr", ["server"], { env, stdio: "ignore" });
    const workspace = await waitFor("Herdr server", () => {
      try {
        return herdr("workspace", "create", "--cwd", dir);
      } catch {
        return undefined;
      }
    });
    const rootPaneId = parseTypeBoxValue(WORKSPACE_CREATED, JSON.parse(workspace), "workspace")
      .result.root_pane.pane_id;

    const session = await resolveHerdrSession({
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: env.HERDR_SOCKET_PATH,
      HERDR_PANE_ID: rootPaneId,
    });
    if (!session) throw new Error(`Herdr did not resolve its own pane ${rootPaneId}.`);

    // Shaped like a cross-directory resume command: a quoted cd, then the worker's command.
    const target = join(dir, "worker target");
    mkdirSync(target);
    const ownerSessionId = randomUUID();
    const piSessionId = randomUUID();
    await createHerdrWorker(session, {
      ownerSessionId,
      name: "Smoke worker",
      cwd: dir,
      command: `cd ${shellQuote(target)} && printf %s 'herdr worker' > ran && sleep 60`,
      piSessionId,
    });

    const ran = join(target, "ran");
    await waitFor("worker command", () =>
      existsSync(ran) && readFileSync(ran, "utf8") === "herdr worker" ? true : undefined,
    );
    await expect(listHerdrWorkers(session.client, ownerSessionId)).resolves.toMatchObject([
      { piSessionId, focused: false },
    ]);
    await expect(closeHerdrWorker(session.client, ownerSessionId, piSessionId)).resolves.toBe(true);
  } finally {
    try {
      herdr("server", "stop");
    } catch {
      server?.kill();
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

async function waitFor<T>(label: string, probe: () => T | undefined, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
