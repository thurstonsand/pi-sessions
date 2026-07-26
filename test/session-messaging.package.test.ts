import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const compiledBrokerPath = "dist/session-messaging/broker/process.js";

interface NpmPackResult {
  files: Array<{ path: string }>;
}

test("package includes the compiled session messaging broker", () => {
  const npmCliPath = process.env.npm_execpath;
  if (!npmCliPath) {
    throw new Error("npm_execpath is required to inspect the package contents.");
  }

  const output = execFileSync(
    process.execPath,
    [npmCliPath, "pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: packageRoot, encoding: "utf8" },
  );
  const result = JSON.parse(output) as NpmPackResult[] | { "pi-sessions": NpmPackResult };
  const pack = Array.isArray(result) ? result[0] : result["pi-sessions"];

  expect(pack?.files.map((file) => file.path)).toContain(compiledBrokerPath);
});

test("compiled broker starts beneath node_modules with raw Node", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "pi-sessions-packed-broker-"));
  const installedPackageDir = join(fixtureDir, "node_modules", "pi-sessions");
  const messagingDir = join(fixtureDir, "messaging");
  mkdirSync(installedPackageDir, { recursive: true });
  cpSync(join(packageRoot, "dist"), join(installedPackageDir, "dist"), { recursive: true });
  copyFileSync(join(packageRoot, "package.json"), join(installedPackageDir, "package.json"));
  cpSync(
    join(packageRoot, "node_modules", "typebox"),
    join(fixtureDir, "node_modules", "typebox"),
    {
      recursive: true,
    },
  );

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
