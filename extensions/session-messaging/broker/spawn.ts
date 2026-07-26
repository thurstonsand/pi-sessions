import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSessionMessagingDir,
  getSessionMessagingSocketPath,
} from "../../shared/session-broker/socket-path.ts";

const BROKER_START_TIMEOUT_MS = 5_000;
const BROKER_CONNECT_TIMEOUT_MS = 1_000;
const BROKER_SPAWN_LOCK_STALE_MS = 10_000;

const brokerDir = getSessionMessagingDir();
const brokerSocketPath = getSessionMessagingSocketPath();
const brokerPidPath = join(brokerDir, "broker.pid");
const brokerSpawnLockPath = join(brokerDir, "broker.spawn.lock");

export async function spawnSessionMessagingBrokerIfNeeded(): Promise<void> {
  mkdirSync(brokerDir, { recursive: true, mode: 0o700 });

  if (await isBrokerRunning()) {
    return;
  }

  if (!acquireSpawnLock()) {
    await waitForBroker();
    return;
  }

  try {
    if (await isBrokerRunning()) {
      return;
    }

    const brokerPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../dist/session-messaging/broker/process.js",
    );
    if (!existsSync(brokerPath)) {
      throw new Error(
        `Session messaging broker build not found: ${brokerPath}. Run npm install in the pi-sessions package directory.`,
      );
    }
    const child = spawn(process.execPath, [brokerPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: process.platform === "win32",
      env: brokerSpawnEnv(),
    });
    child.unref();
    await waitForBroker();
  } finally {
    releaseSpawnLock();
  }
}

async function isBrokerRunning(): Promise<boolean> {
  if (await canConnectToBroker()) {
    return true;
  }

  if (!existsSync(brokerPidPath)) {
    return false;
  }

  try {
    const pid = Number.parseInt(readFileSync(brokerPidPath, "utf8").trim(), 10);
    if (!Number.isFinite(pid)) {
      return false;
    }
    process.kill(pid, 0);
    return canConnectToBroker();
  } catch {
    return false;
  }
}

function canConnectToBroker(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(brokerSocketPath);
    const finish = (connected: boolean): void => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      resolve(connected);
    };
    const onConnect = (): void => {
      socket.end();
      finish(true);
    };
    const onError = (): void => {
      socket.destroy();
      finish(false);
    };
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(false);
    }, BROKER_CONNECT_TIMEOUT_MS);
    socket.on("connect", onConnect);
    socket.on("error", onError);
  });
}

async function waitForBroker(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < BROKER_START_TIMEOUT_MS) {
    if (await canConnectToBroker()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Session messaging broker failed to start.");
}

function acquireSpawnLock(): boolean {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      writeFileSync(brokerSpawnLockPath, `${process.pid}\n${Date.now()}\n`, {
        flag: "wx",
      });
      return true;
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (isSpawnLockStale()) {
        try {
          unlinkSync(brokerSpawnLockPath);
        } catch {}
        continue;
      }
      return false;
    }
  }

  return false;
}

function isSpawnLockStale(): boolean {
  if (!existsSync(brokerSpawnLockPath)) {
    return false;
  }

  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync(brokerSpawnLockPath, "utf8")
      .trim()
      .split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);

    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
    }

    return !Number.isFinite(createdAt) || Date.now() - createdAt > BROKER_SPAWN_LOCK_STALE_MS;
  } catch {
    return true;
  }
}

function releaseSpawnLock(): void {
  try {
    unlinkSync(brokerSpawnLockPath);
  } catch {}
}

function brokerSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // process.execPath is the Pi executable. As a Bun-compiled binary it treats a
  // positional path as a file argument to the agent, not a script to run, which
  // would relaunch a full agent session and recurse. BUN_BE_BUN makes it behave
  // as the Bun CLI and execute the broker. It is set whenever Bun is the runtime
  // (compiled binary or `bun run`) and ignored by a plain Node launch.
  if (process.versions.bun) {
    env.BUN_BE_BUN = "1";
  }
  return env;
}
