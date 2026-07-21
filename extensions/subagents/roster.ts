import {
  type SessionEntry,
  SessionManager,
  type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import { listTmuxWindows, type TmuxExecutor, tmuxSessionName } from "../shared/tmux.ts";
import { classifySubagent, type SubagentState } from "./classify.ts";
import {
  type ChildSubagentLifecycle,
  collectParentLedger,
  getChildSubagentLifecycle,
  type ParentSubagentLaunch,
  type ParentSubagentLedger,
} from "./ledger.ts";
import type { ReconcileResult } from "./reconcile.ts";

export type SubagentRelationScope = "branch" | "tree";

export interface SubagentRosterEntry {
  sessionId: string;
  sessionFile: string;
  ownerSessionId: string;
  ownerTitle: string;
  ownerIsCurrentSession: boolean;
  title: string;
  goal: string;
  model?: string | undefined;
  cwd: string;
  resumeCommand: string;
  launchedAt: string;
  depth: number;
  state: SubagentState;
  onActiveBranch: boolean;
  managedLive: boolean;
  tmuxWindowId?: string | undefined;
}

export interface SubagentRosterResult {
  entries: readonly SubagentRosterEntry[];
  total: number;
}

export interface SubagentRoster {
  resolve(scope: SubagentRelationScope): Promise<SubagentRosterResult>;
}

interface RosterSession {
  sessionId: string;
  getSessionName(): string | undefined;
  getBranch(fromId?: string): readonly SessionEntry[];
  getTree(): readonly SessionTreeNode[];
}

interface RosterParentSession extends RosterSession {
  epoch: number;
}

interface RosterDependencies {
  executor: TmuxExecutor;
  messaging: { listSessions(): Promise<string[]> };
  getParent(): RosterParentSession | undefined;
  reconcile(): Promise<ReconcileResult>;
  openSession(path: string): RosterSession;
}

interface TraversedSubagent {
  launch: ParentSubagentLaunch;
  ownerSessionId: string;
  ownerTitle: string;
  ownerIsCurrentSession: boolean;
  ownerActiveLedger: ParentSubagentLedger;
  onActiveBranch: boolean;
  lifecycle: ChildSubagentLifecycle | undefined;
}

export class TranscriptSubagentRoster implements SubagentRoster {
  constructor(private readonly deps: RosterDependencies) {}

  async resolve(scope: SubagentRelationScope): Promise<SubagentRosterResult> {
    const parent = this.deps.getParent();
    if (!parent) {
      throw new Error("Subagent roster is unavailable before session start.");
    }

    const reconciliation = await this.deps.reconcile();
    const traversed = this.traverse(parent, scope);
    const brokerLive = new Set(await this.deps.messaging.listSessions());

    const ownerSessionIds = [...new Set(traversed.map((child) => child.ownerSessionId))];
    const windowsByOwner = new Map(
      await Promise.all(
        ownerSessionIds.map(async (ownerSessionId) => {
          const windows = await listTmuxWindows(
            this.deps.executor,
            tmuxSessionName(ownerSessionId),
          );
          return [
            ownerSessionId,
            new Map(windows.map((window) => [window.piSessionId, window])),
          ] as const;
        }),
      ),
    );

    const entries = traversed.map((child): SubagentRosterEntry => {
      const childSessionId = child.launch.childSessionId;
      const window = windowsByOwner.get(child.ownerSessionId)?.get(childSessionId);
      const hasWindow = window !== undefined;
      const isBrokerLive = brokerLive.has(childSessionId);
      const activeLedger = child.ownerActiveLedger;
      const lifecycle = child.lifecycle;
      const state =
        reconciliation.states.get(childSessionId) ??
        classifySubagent({
          hasWindow,
          brokerLive: isBrokerLive,
          hasRegistered: reconciliation.registered.has(childSessionId),
          cancelled: activeLedger.cancelledChildIds.has(childSessionId),
          suspended: activeLedger.suspendedChildIds.has(childSessionId),
          hasReportOrClosure: Boolean(lifecycle?.reports.length || lifecycle?.closed),
          childReadable: lifecycle !== undefined,
        });

      return {
        sessionId: childSessionId,
        sessionFile: child.launch.childSessionFile,
        ownerSessionId: child.ownerSessionId,
        ownerTitle: child.ownerTitle,
        ownerIsCurrentSession: child.ownerIsCurrentSession,
        title: child.launch.title,
        goal: child.launch.goal,
        ...(child.launch.model ? { model: child.launch.model } : {}),
        cwd: child.launch.cwd,
        resumeCommand: child.launch.resumeCommand,
        launchedAt: child.launch.launchedAt,
        depth: child.launch.depth,
        state,
        onActiveBranch: child.onActiveBranch,
        managedLive: hasWindow || isBrokerLive,
        ...(window ? { tmuxWindowId: window.windowId } : {}),
      };
    });

    return { entries, total: entries.length };
  }

  private traverse(root: RosterSession, scope: SubagentRelationScope): TraversedSubagent[] {
    const results = new Map<string, TraversedSubagent>();
    const openedChildren = new Map<string, RosterSession | undefined>();
    const visitedOwners = new Set<string>();
    const queue: RosterSession[] = [root];

    while (queue.length > 0) {
      const owner = queue.shift();
      if (!owner || visitedOwners.has(owner.sessionId)) {
        continue;
      }
      visitedOwners.add(owner.sessionId);

      const activeBranch = owner.getBranch();
      const activeLedger = collectParentLedger(activeBranch, owner.sessionId);
      const activeChildIds = new Set(activeLedger.launches.map((launch) => launch.childSessionId));
      const launches =
        scope === "branch" ? activeLedger.launches : collectTreeLaunches(owner, owner.sessionId);

      for (const launch of launches) {
        let child: RosterSession | undefined;
        let lifecycle: ChildSubagentLifecycle | undefined;
        try {
          if (openedChildren.has(launch.childSessionId)) {
            child = openedChildren.get(launch.childSessionId);
          } else {
            child = this.deps.openSession(launch.childSessionFile);
            if (child.sessionId !== launch.childSessionId) {
              child = undefined;
            }
            openedChildren.set(launch.childSessionId, child);
          }

          const childBranch = child?.getBranch();
          if (!childBranch) {
            child = undefined;
          } else {
            lifecycle = getChildSubagentLifecycle(childBranch);
          }
        } catch {
          child = undefined;
          openedChildren.set(launch.childSessionId, undefined);
        }

        const existing = results.get(launch.childSessionId);
        const candidate: TraversedSubagent = {
          launch,
          ownerSessionId: owner.sessionId,
          ownerTitle: owner.getSessionName()?.trim() || "Untitled session",
          ownerIsCurrentSession: owner.sessionId === root.sessionId,
          ownerActiveLedger: activeLedger,
          onActiveBranch: activeChildIds.has(launch.childSessionId),
          lifecycle,
        };
        if (!existing || candidate.launch.depth < existing.launch.depth) {
          results.set(launch.childSessionId, candidate);
        }
        if (child && !visitedOwners.has(child.sessionId)) {
          queue.push(child);
        }
      }
    }

    return [...results.values()];
  }
}

export function openRosterSession(path: string): RosterSession {
  const manager = SessionManager.open(path);
  return {
    sessionId: manager.getSessionId(),
    getSessionName: () => manager.getSessionName(),
    getBranch: (fromId) => manager.getBranch(fromId),
    getTree: () => manager.getTree(),
  };
}

function collectTreeLaunches(
  session: RosterSession,
  ownerSessionId: string,
): ParentSubagentLaunch[] {
  const launches = new Map<string, ParentSubagentLaunch>();
  for (const leafId of collectLeafIds(session.getTree())) {
    const ledger = collectParentLedger(session.getBranch(leafId), ownerSessionId);
    for (const launch of ledger.launches) {
      const existing = launches.get(launch.childSessionId);
      if (!existing || launch.launchedAt > existing.launchedAt) {
        launches.set(launch.childSessionId, launch);
      }
    }
  }
  return [...launches.values()];
}

function collectLeafIds(roots: readonly SessionTreeNode[]): string[] {
  const leafIds: string[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.children.length === 0) {
      leafIds.push(node.entry.id);
    } else {
      stack.push(...node.children);
    }
  }
  return leafIds;
}
