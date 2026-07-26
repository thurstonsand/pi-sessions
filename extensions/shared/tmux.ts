import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

const TMUX_COMMAND = "tmux";
const TMUX_TIMEOUT_MS = 15_000;
const SESSION_ID_OPTION = "@pi_session_id";
const WINDOW_FORMAT = "#{window_id}\t#{window_name}\t#{@pi_session_id}";

export interface TmuxWindow {
  windowId: string;
  name: string;
  piSessionId: string;
}

export interface CreateTmuxWindowOptions {
  tmuxSession: string;
  name: string;
  cwd: string;
  command: string;
  piSessionId: string;
}

export interface TmuxExecutor {
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}

export function isInsideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TMUX);
}

export function tmuxSessionName(parentSessionId: string): string {
  const hex = parentSessionId.replaceAll("-", "").match(/^[0-9a-fA-F]+/)?.[0] ?? "";
  if (hex.length < 8) {
    throw new Error(`Cannot derive tmux session name from session id: ${parentSessionId}`);
  }
  return `pi-${hex.slice(0, 12).toLowerCase()}`;
}

export async function isTmuxInstalled(executor: TmuxExecutor, cwd: string): Promise<boolean> {
  const result = await executor.exec(TMUX_COMMAND, ["-V"], { cwd, timeout: TMUX_TIMEOUT_MS });
  return result.code === 0;
}

export async function listTmuxWindows(
  executor: TmuxExecutor,
  tmuxSession: string,
): Promise<TmuxWindow[]> {
  const result = await executor.exec(
    TMUX_COMMAND,
    ["list-windows", "-t", tmuxSession, "-F", WINDOW_FORMAT],
    { timeout: TMUX_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    if (isMissingSession(result)) {
      return [];
    }
    throw tmuxError("list windows", result);
  }

  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map(parseWindow)
    .filter((window): window is TmuxWindow => window !== undefined);
}

export async function hasAttachedTmuxClients(
  executor: TmuxExecutor,
  tmuxSession: string,
): Promise<boolean> {
  const result = await executor.exec(
    TMUX_COMMAND,
    ["list-clients", "-t", tmuxSession, "-F", "#{client_name}"],
    { timeout: TMUX_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    if (isMissingSession(result)) {
      return false;
    }
    throw tmuxError("list attached clients", result);
  }
  return result.stdout.split("\n").some((line) => line.trim().length > 0);
}

const pendingCreations = new Map<string, Promise<unknown>>();

// Creating a window is check-then-act: it asks whether the tmux session exists and then either
// creates it or adds to it. Sibling subagents launched in one turn share a session name and race,
// so all but the winner get `duplicate session`. Only the parent's process ever creates its own
// session name, so serializing here is enough to close the window.
export async function createTmuxWindow(
  executor: TmuxExecutor,
  options: CreateTmuxWindowOptions,
): Promise<TmuxWindow> {
  const preceding = pendingCreations.get(options.tmuxSession) ?? Promise.resolve();
  const creation = preceding.catch(() => {}).then(() => createWindow(executor, options));
  pendingCreations.set(options.tmuxSession, creation);
  try {
    return await creation;
  } finally {
    if (pendingCreations.get(options.tmuxSession) === creation) {
      pendingCreations.delete(options.tmuxSession);
    }
  }
}

async function createWindow(
  executor: TmuxExecutor,
  options: CreateTmuxWindowOptions,
): Promise<TmuxWindow> {
  const existing = (await listTmuxWindows(executor, options.tmuxSession)).find(
    (window) => window.piSessionId === options.piSessionId,
  );
  if (existing) {
    return existing;
  }

  const sessionExists = await hasTmuxSession(executor, options.tmuxSession);
  const args = sessionExists
    ? [
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "-t",
        options.tmuxSession,
        "-n",
        options.name,
        "-c",
        options.cwd,
        options.command,
      ]
    : [
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "-s",
        options.tmuxSession,
        "-n",
        options.name,
        "-c",
        options.cwd,
        options.command,
      ];
  const created = await executor.exec(TMUX_COMMAND, args, {
    cwd: options.cwd,
    timeout: TMUX_TIMEOUT_MS,
  });
  if (created.code !== 0) {
    throw tmuxError("create window", created);
  }

  const windowId = created.stdout.trim();
  if (!windowId) {
    throw new Error("tmux created a window without returning its id.");
  }
  const stamped = await executor.exec(
    TMUX_COMMAND,
    ["set-option", "-w", "-t", windowId, SESSION_ID_OPTION, options.piSessionId],
    { timeout: TMUX_TIMEOUT_MS },
  );
  if (stamped.code !== 0) {
    await executor.exec(TMUX_COMMAND, ["kill-window", "-t", windowId], {
      timeout: TMUX_TIMEOUT_MS,
    });
    throw tmuxError("stamp window", stamped);
  }

  return { windowId, name: options.name, piSessionId: options.piSessionId };
}

export async function killTmuxWindow(
  executor: TmuxExecutor,
  tmuxSession: string,
  piSessionId: string,
): Promise<boolean> {
  const windows = await listTmuxWindows(executor, tmuxSession);
  for (const window of windows.filter((candidate) => candidate.piSessionId === piSessionId)) {
    await executor.exec(TMUX_COMMAND, ["kill-window", "-t", window.windowId], {
      timeout: TMUX_TIMEOUT_MS,
    });
  }
  return !(await listTmuxWindows(executor, tmuxSession)).some(
    (window) => window.piSessionId === piSessionId,
  );
}

export async function killTmuxSession(
  executor: TmuxExecutor,
  tmuxSession: string,
): Promise<boolean> {
  const result = await executor.exec(TMUX_COMMAND, ["kill-session", "-t", tmuxSession], {
    timeout: TMUX_TIMEOUT_MS,
  });
  if (result.code !== 0 && !isMissingSession(result)) {
    return false;
  }
  return !(await hasTmuxSession(executor, tmuxSession));
}

async function hasTmuxSession(executor: TmuxExecutor, tmuxSession: string): Promise<boolean> {
  const result = await executor.exec(TMUX_COMMAND, ["has-session", "-t", tmuxSession], {
    timeout: TMUX_TIMEOUT_MS,
  });
  return result.code === 0;
}

function parseWindow(line: string): TmuxWindow | undefined {
  const [windowId, name, piSessionId] = line.split("\t");
  if (!windowId || name === undefined || !piSessionId) {
    return undefined;
  }
  return { windowId, name, piSessionId };
}

function isMissingSession(result: ExecResult): boolean {
  return /can't find session|no server running|failed to connect to server|error connecting to .*no such file/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

function tmuxError(action: string, result: ExecResult): Error {
  const details = `${result.stderr || result.stdout}`.trim() || `exit code ${result.code}`;
  return new Error(`Failed to ${action} with tmux: ${details}`);
}
