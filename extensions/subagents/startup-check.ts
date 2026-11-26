import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { findPendingHandoffBootstrap } from "../session-handoff/metadata.ts";
import type { SubagentLaunched } from "./ledger.ts";
import type { WorkerRuntime } from "./worker-runtime.ts";

export const WORKER_STARTUP_CHECK_MS = 2_000;

export interface WorkerStartupCheck {
  runtime: WorkerRuntime;
  ownerSessionId: string;
  launch: SubagentLaunched;
  isCurrent(): boolean;
  readChildBranch(sessionFile: string): readonly SessionEntry[];
  /** `failure` is the child's recorded bootstrap error, when it got far enough to write one. */
  onExited(failure: string | undefined): void;
  onError(error: unknown): void;
}

/**
 * A worker that dies as it starts never reports, so its parent would wait forever. This looks
 * once, shortly after launch and off the launch path, for a worker whose window is gone while its
 * child never kicked off. A child that finished quickly has kicked off and is left alone.
 */
export function checkWorkerStartup(check: WorkerStartupCheck): void {
  const timer = setTimeout(() => {
    void (async () => {
      if (!check.isCurrent()) return;
      const windows = await check.runtime.list(check.ownerSessionId);
      if (windows.some((window) => window.piSessionId === check.launch.childSessionId)) return;
      const scan = findPendingHandoffBootstrap(
        check.readChildBranch(check.launch.childSessionFile),
      );
      if (scan?.kind !== "pending" || !check.isCurrent()) return;
      check.onExited(scan.failure);
    })().catch(check.onError);
  }, WORKER_STARTUP_CHECK_MS);
  timer.unref();
}

export function formatWorkerExitedMessage(
  launch: SubagentLaunched,
  failure: string | undefined,
): string {
  return [
    `[system] Subagent "${launch.title}" (session: ${launch.childSessionId}) exited before it started its task, so it will not report.`,
    failure
      ? `It failed with: ${failure}`
      : `Its worker closed within ${WORKER_STARTUP_CHECK_MS / 1_000}s of launch. Check that its command runs on this machine: ${launch.resumeCommand}`,
    "Messaging it starts the worker again.",
  ].join("\n");
}
