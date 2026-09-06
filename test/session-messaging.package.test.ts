import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const compiledBrokerPath = "dist/session-messaging/broker/process.js";

interface NpmPackResult {
  files: Array<{ path: string }>;
}

// The runner may be npm or mise, so npm is located through npm_execpath when
// present and otherwise resolved from PATH.
function runNpmPack(): string {
  const args = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const npmCliPath = process.env.npm_execpath;
  const [command, commandArgs] = npmCliPath
    ? [process.execPath, [npmCliPath, ...args]]
    : ["npm", args];

  return execFileSync(command, commandArgs, { cwd: packageRoot, encoding: "utf8" });
}

test("package includes the compiled session messaging broker", () => {
  const output = runNpmPack();
  const result = JSON.parse(output) as NpmPackResult[] | { "pi-sessions": NpmPackResult };
  const pack = Array.isArray(result) ? result[0] : result["pi-sessions"];

  expect(pack?.files.map((file) => file.path)).toContain(compiledBrokerPath);
});

test("compiled broker starts with no dependencies installed", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "pi-sessions-packed-broker-"));
  const installedPackageDir = join(fixtureDir, "node_modules", "pi-sessions");
  const messagingDir = join(fixtureDir, "messaging");
  mkdirSync(installedPackageDir, { recursive: true });
  cpSync(join(packageRoot, "dist"), join(installedPackageDir, "dist"), { recursive: true });
  copyFileSync(join(packageRoot, "package.json"), join(installedPackageDir, "package.json"));

  // The broker must boot from a checkout whose `npm install` never ran, so the
  // fixture deliberately holds nothing but the package itself.
  expect(readdirSync(join(fixtureDir, "node_modules"))).toEqual(["pi-sessions"]);

  const child = spawn(process.execPath, [join(installedPackageDir, compiledBrokerPath)], {
    env: { ...process.env, PI_SESSIONS_MESSAGING_DIR: messagingDir },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await waitForBrokerPid(join(messagingDir, "broker.pid"), child);
    expect(Number.parseInt(readFileSync(join(messagingDir, "broker.pid"), "utf8"), 10)).toBe(
      child.pid,
    );
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`.trim());
  } finally {
    child.kill("SIGTERM");
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

async function waitForBrokerPid(pidPath: string, child: ReturnType<typeof spawn>): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (existsSync(pidPath)) return;
    if (child.exitCode !== null) {
      throw new Error(`Broker exited with code ${child.exitCode} before listening.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Broker did not start within 5 seconds.");
}

test("broker startup preserves the real failure and identifies its log", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "pi-broker-failure-"));
  try {
    for (const relative of [
      "extensions/session-messaging/broker/spawn.ts",
      "extensions/shared/session-broker/socket-path.ts",
      "dist/session-messaging/broker/process.js",
      "package.json",
    ]) {
      const destination = join(fixtureDir, relative);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(packageRoot, relative), destination);
    }
    // The packaged process exists, but its imports are missing: exercise an actual child crash.
    const spawnUrl = pathToFileURL(
      join(fixtureDir, "extensions/session-messaging/broker/spawn.ts"),
    ).href;
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { spawnSessionMessagingBrokerIfNeeded } from ${JSON.stringify(spawnUrl)};
         try { await spawnSessionMessagingBrokerIfNeeded(); process.exitCode = 1; }
         catch (error) { console.log(error.message); }`,
      ],
      {
        env: { ...process.env, PI_SESSIONS_MESSAGING_DIR: join(fixtureDir, "messaging") },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    const logPath = join(fixtureDir, "messaging", "broker.log");
    expect(output).toContain("broker exited");
    expect(output).toContain(logPath);
    expect(readFileSync(logPath, "utf8")).toContain("ERR_MODULE_NOT_FOUND");
    expect(existsSync(join(fixtureDir, "messaging", "broker.spawn.lock"))).toBe(false);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
