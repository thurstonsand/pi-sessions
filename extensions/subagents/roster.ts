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
  type ParentSubagentLedger,
  type SubagentLaunched,
} from "./ledger.ts";
import type { ReconcileResult } from "./reconcile.ts";

export type SubagentRelationScope = "branch" | "tree";

export interface SubagentRosterEntry {
  sessionId: string;
  sessionFile: string;
  ownerSessionId: string;
  title: string;
  goal: string;
  depth: number;
  state: SubagentState;
  onActiveBranch: boolean;
  managedLive: boolean;
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
  launch: SubagentLaunched;
  ownerSessionId: string;
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
        ownerSessionIds.map(
          async (ownerSessionId) =>
            [
              ownerSessionId,
              new Set(
                (await listTmuxWindows(this.deps.executor, tmuxSessionName(ownerSessionId))).map(
                  (window) => window.piSessionId,
                ),
              ),
            ] as const,
        ),
      ),
    );

    const entries = traversed.map((child): SubagentRosterEntry => {
      const childSessionId = child.launch.childSessionId;
      const hasWindow = windowsByOwner.get(child.ownerSessionId)?.has(childSessionId) ?? false;
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
        title: child.launch.title,
        goal: child.launch.goal,
        depth: child.launch.depth,
        state,
        onActiveBranch: child.onActiveBranch,
        managedLive: hasWindow || isBrokerLive,
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
    getBranch: (fromId) => manager.getBranch(fromId),
    getTree: () => manager.getTree(),
  };
}

function collectTreeLaunches(session: RosterSession, ownerSessionId: string): SubagentLaunched[] {
  const launches = new Map<string, SubagentLaunched>();
  for (const leafId of collectLeafIds(session.getTree())) {
    for (const launch of collectParentLedger(session.getBranch(leafId), ownerSessionId).launches) {
      launches.set(launch.childSessionId, launch);
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
