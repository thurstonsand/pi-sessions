import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSessionMessagingSocketPath } from "../../shared/session-broker/socket-path.ts";

const BROKER_START_TIMEOUT_MS = 5_000;
const BROKER_CONNECT_TIMEOUT_MS = 1_000;
const BROKER_SPAWN_LOCK_STALE_MS = 10_000;

interface BrokerPaths {
  dir: string;
  socket: string;
  pid: string;
  spawnLock: string;
  log: string;
}

export async function spawnSessionMessagingBrokerIfNeeded(messagingDir: string): Promise<void> {
  const paths: BrokerPaths = {
    dir: messagingDir,
    socket: getSessionMessagingSocketPath(messagingDir),
    pid: join(messagingDir, "broker.pid"),
    spawnLock: join(messagingDir, "broker.spawn.lock"),
    log: join(messagingDir, "broker.log"),
  };
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });

  if (await isBrokerRunning(paths)) {
    return;
  }

  if (!acquireSpawnLock(paths)) {
    await waitForBroker(paths);
    return;
  }

  try {
    if (await isBrokerRunning(paths)) {
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
    const log = openSync(paths.log, "w", 0o600);
    try {
      const child = spawn(process.execPath, [brokerPath, paths.dir], {
        detached: true,
        stdio: ["ignore", log, log],
        windowsHide: process.platform === "win32",
        env: brokerSpawnEnv(),
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      await waitForBroker(paths, child);
    } finally {
      closeSync(log);
    }
  } finally {
    releaseSpawnLock(paths);
  }
}

async function isBrokerRunning(paths: BrokerPaths): Promise<boolean> {
  if (await canConnectToBroker(paths)) {
    return true;
  }

  if (!existsSync(paths.pid)) {
    return false;
  }

  try {
    const pid = Number.parseInt(readFileSync(paths.pid, "utf8").trim(), 10);
    if (!Number.isFinite(pid)) {
      return false;
    }
    process.kill(pid, 0);
    return canConnectToBroker(paths);
  } catch {
    return false;
  }
}

function canConnectToBroker(paths: BrokerPaths): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(paths.socket);
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

async function waitForBroker(paths: BrokerPaths, child?: ChildProcess): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < BROKER_START_TIMEOUT_MS) {
    if (await canConnectToBroker(paths)) {
      return;
    }
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(
        `Session messaging broker exited (${child.signalCode ?? child.exitCode}). See ${paths.log}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Session messaging broker failed to start. See ${paths.log}.`);
}

function acquireSpawnLock(paths: BrokerPaths): boolean {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      writeFileSync(paths.spawnLock, `${process.pid}\n${Date.now()}\n`, {
        flag: "wx",
      });
      return true;
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (isSpawnLockStale(paths)) {
        try {
          unlinkSync(paths.spawnLock);
        } catch {}
        continue;
      }
      return false;
    }
  }

  return false;
}

function isSpawnLockStale(paths: BrokerPaths): boolean {
  if (!existsSync(paths.spawnLock)) {
    return false;
  }

  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync(paths.spawnLock, "utf8")
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

function releaseSpawnLock(paths: BrokerPaths): void {
  try {
    unlinkSync(paths.spawnLock);
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
