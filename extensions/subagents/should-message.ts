import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isSessionStarting } from "../session-handoff/metadata.ts";
import { listTmuxWindows, type TmuxExecutor, tmuxSessionName } from "../shared/tmux.ts";
import { classifySubagent } from "./classify.ts";
import { collectParentLedger, getChildSubagentLifecycle } from "./ledger.ts";

interface SubagentSession {
  sessionId: string;
  getBranch(): readonly SessionEntry[];
}

export interface ShouldMessageSubagentDependencies {
  executor: TmuxExecutor;
  messaging: { listSessions(): Promise<string[]> };
  getParent(): SubagentSession | undefined;
  openSession(path: string): SubagentSession;
}

export async function shouldMessageSubagent(
  sessionId: string,
  deps: ShouldMessageSubagentDependencies,
): Promise<boolean> {
  const parent = deps.getParent();
  if (!parent) {
    return false;
  }
  const ledger = collectParentLedger(parent.getBranch(), parent.sessionId);
  const launch = ledger.launches.find((entry) => entry.childSessionId === sessionId);
  if (!launch || ledger.cancelledChildIds.has(sessionId)) {
    return false;
  }

  const [windows, liveSessions] = await Promise.all([
    listTmuxWindows(deps.executor, tmuxSessionName(parent.sessionId)),
    deps.messaging.listSessions(),
  ]);
  let childBranch: readonly SessionEntry[] | undefined;
  try {
    const child = deps.openSession(launch.childSessionFile);
    if (child.sessionId === sessionId) {
      childBranch = child.getBranch();
    }
  } catch {
    // An unreadable transcript cannot establish that an owned child has finished.
  }
  const lifecycle = childBranch ? getChildSubagentLifecycle(childBranch) : undefined;
  const brokerLive = liveSessions.includes(sessionId);
  const state = classifySubagent({
    hasWindow: windows.some((window) => window.piSessionId === sessionId),
    brokerLive,
    hasRegistered: brokerLive,
    awaitingKickoff: childBranch ? isSessionStarting(childBranch) : false,
    cancelled: false,
    suspended: ledger.suspendedChildIds.has(sessionId),
    hasReportOrClosure: Boolean(lifecycle?.reports.length || lifecycle?.closed),
    childReadable: childBranch !== undefined,
  });
  return state !== "completed" && state !== "stopped";
}
