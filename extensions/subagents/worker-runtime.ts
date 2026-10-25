import { shellQuote } from "../session-handoff/launch/shell.ts";
import {
  createTmuxWindow,
  hasAttachedTmuxClients,
  isInsideTmux,
  killTmuxSession,
  killTmuxWindow,
  listTmuxWindows,
  type TmuxExecutor,
  tmuxSessionName,
} from "../shared/tmux.ts";

export interface WorkerWindow {
  piSessionId: string;
  /** A shell command that brings the worker's window into view. */
  observeCommand: string;
}

export interface CreateWorkerOptions {
  name: string;
  cwd: string;
  command: string;
  piSessionId: string;
}

/** Where an owner's detached workers run: one stamped window per busy subagent. */
export interface WorkerRuntime {
  name: string;
  list(ownerSessionId: string): Promise<WorkerWindow[]>;
  create(ownerSessionId: string, options: CreateWorkerOptions): Promise<void>;
  /** Resolves true once no window remains for the worker. */
  stop(ownerSessionId: string, piSessionId: string): Promise<boolean>;
  stopAll(ownerSessionId: string): Promise<boolean>;
  /** Whether someone is looking at the worker, so it should outlive its settled turn. */
  isWatched(ownerSessionId: string, piSessionId: string): Promise<boolean>;
}

export function createTmuxWorkerRuntime(
  executor: TmuxExecutor,
  env: NodeJS.ProcessEnv = process.env,
): WorkerRuntime {
  return {
    name: "tmux",
    async list(ownerSessionId) {
      const tmuxSession = tmuxSessionName(ownerSessionId);
      const verb = isInsideTmux(env) ? "switch-client" : "attach-session";
      return (await listTmuxWindows(executor, tmuxSession)).map((window) => ({
        piSessionId: window.piSessionId,
        observeCommand: `tmux ${verb} -t ${shellQuote(`${tmuxSession}:${window.windowId}`)}`,
      }));
    },
    async create(ownerSessionId, options) {
      await createTmuxWindow(executor, {
        tmuxSession: tmuxSessionName(ownerSessionId),
        ...options,
      });
    },
    stop: (ownerSessionId, piSessionId) =>
      killTmuxWindow(executor, tmuxSessionName(ownerSessionId), piSessionId),
    stopAll: (ownerSessionId) => killTmuxSession(executor, tmuxSessionName(ownerSessionId)),
    isWatched: (ownerSessionId) =>
      hasAttachedTmuxClients(executor, tmuxSessionName(ownerSessionId)),
  };
}
