import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createTmuxWindow,
  killTmuxSession,
  killTmuxWindow,
  listTmuxWindows,
  type TmuxExecutor,
  tmuxSessionName,
} from "../shared/tmux.ts";
import { classifySubagent, type SubagentEvidence, type SubagentState } from "./classify.ts";
import {
  type ChildSubagentLifecycle,
  collectParentLedger,
  getChildSubagentLifecycle,
  type ParentSubagentLedger,
  SUBAGENT_DISOWNED_NOTICE_CUSTOM_TYPE,
  SUBAGENT_LAUNCHED_CUSTOM_TYPE,
  SUBAGENT_OWNERSHIP_CLOSED_CUSTOM_TYPE,
  SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
  SUBAGENT_SUSPENDED_CUSTOM_TYPE,
  type SubagentClosed,
  type SubagentLaunched,
  type SubagentReport,
} from "./ledger.ts";
import { SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE } from "./report.ts";

export interface ReconcileParentSession {
  sessionId: string;
  epoch: number;
  getBranch(): readonly SessionEntry[];
}

export interface ReconcileSessionManager {
  getBranch(): readonly SessionEntry[];
}

export interface ReconcileMessaging {
  listSessions(): Promise<string[]>;
}

export interface ReconcileActions extends TmuxExecutor {
  appendEntry(customType: string, data: unknown): void;
  sendMessage(message: { customType: string; content: string; display: boolean }): void;
}

export interface ReconcileDependencies {
  executor: ReconcileActions;
  messaging: ReconcileMessaging;
  getParent(): ReconcileParentSession | undefined;
  isCurrent(epoch: number): boolean;
  openSession(path: string): ReconcileSessionManager;
}

interface ChildLifecycle extends ChildSubagentLifecycle {
  readable: boolean;
}

interface ChildEvidence {
  launch: SubagentLaunched;
  classification: SubagentEvidence;
  state: SubagentState;
  hasOwnershipClosure: boolean;
  reports: readonly SubagentReport[];
  closed: SubagentClosed | undefined;
}

export interface ReconcileResult {
  states: ReadonlyMap<string, SubagentState>;
}

/**
 * Converges the runtime view of a parent's owned subagents from their durable ledgers.
 * It intentionally does not cache child files: every trigger observes current branch truth.
 */
export class SubagentReconciler {
  private inFlight: Promise<ReconcileResult> | undefined;
  private dirty = false;
  private restoreSuspended = false;
  private shuttingDown = false;
  private registered: { epoch: number; sessionIds: Set<string> } | undefined;
  private latestResult: ReconcileResult = { states: new Map() };

  constructor(private readonly deps: ReconcileDependencies) {}

  beginSession(): void {
    this.shuttingDown = false;
    this.dirty = false;
    this.restoreSuspended = false;
    this.registered = undefined;
    this.latestResult = { states: new Map() };
  }

  reconcile(): Promise<ReconcileResult> {
    return this.requestReconciliation(false);
  }

  reconcileAndRestoreSuspended(): Promise<ReconcileResult> {
    return this.requestReconciliation(true);
  }

  private requestReconciliation(restoreSuspended: boolean): Promise<ReconcileResult> {
    if (this.shuttingDown) {
      return this.inFlight ?? Promise.resolve(this.latestResult);
    }
    this.dirty = true;
    this.restoreSuspended ||= restoreSuspended;
    if (this.inFlight) {
      return this.inFlight;
    }

    const run = this.run().finally(() => {
      if (this.inFlight === run) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = run;
    return run;
  }

  async suspendForShutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.inFlight;

    const parent = this.deps.getParent();
    if (!parent) {
      return;
    }

    const tmuxSession = tmuxSessionName(parent.sessionId);
    const ledger = collectParentLedger(parent.getBranch(), parent.sessionId);
    const windows = await listTmuxWindows(this.deps.executor, tmuxSession);
    const ownedChildIds = new Set(ledger.launches.map((launch) => launch.childSessionId));
    const childSessionIds = windows
      .map((window) => window.piSessionId)
      .filter((childSessionId) => ownedChildIds.has(childSessionId));

    if (childSessionIds.length > 0) {
      this.append(parent, SUBAGENT_SUSPENDED_CUSTOM_TYPE, {
        writerSessionId: parent.sessionId,
        childSessionIds,
      });
    }
    this.requireCurrent(parent);
    await killTmuxSession(this.deps.executor, tmuxSession);
  }

  private async run(): Promise<ReconcileResult> {
    while (this.dirty && !this.shuttingDown) {
      this.dirty = false;
      const restoreSuspended = this.restoreSuspended;
      this.restoreSuspended = false;
      this.latestResult = await this.reconcileOnce(restoreSuspended);
    }
    return this.latestResult;
  }

  private async reconcileOnce(restoreSuspended: boolean): Promise<ReconcileResult> {
    const parent = this.deps.getParent();
    if (!parent) {
      return { states: new Map() };
    }

    const branch = parent.getBranch();
    const ledger = collectParentLedger(branch, parent.sessionId);
    const tmuxSession = tmuxSessionName(parent.sessionId);
    const [windows, liveSessionIds] = await Promise.all([
      listTmuxWindows(this.deps.executor, tmuxSession),
      this.deps.messaging.listSessions(),
    ]);
    const liveSessions = new Set(liveSessionIds);
    const registered = this.getRegistered(parent.epoch);
    for (const sessionId of liveSessionIds) {
      registered.add(sessionId);
    }
    const windowSessionIds = new Set(windows.map((window) => window.piSessionId));
    const evidence = ledger.launches.map((launch) =>
      this.readChildEvidence(
        launch,
        ledger,
        windowSessionIds.has(launch.childSessionId),
        liveSessions.has(launch.childSessionId),
        registered.has(launch.childSessionId),
      ),
    );

    let runtimeChanged = false;

    if (ledger.hasForeignLaunch && !ledger.hasDisownedNotice) {
      this.append(parent, SUBAGENT_DISOWNED_NOTICE_CUSTOM_TYPE, {
        writerSessionId: parent.sessionId,
      });
      this.sendSystemLine(
        parent,
        "[system] copied subagent records belong to the original session; this fork owns none.",
      );
    }

    for (const child of evidence) {
      if (child.state === "unknown") {
        continue;
      }

      for (const report of child.reports) {
        if (ledger.receivedReportIds.has(report.reportId)) {
          continue;
        }
        this.append(parent, SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE, {
          writerSessionId: parent.sessionId,
          childSessionId: child.launch.childSessionId,
          ...report,
          provenance: "recovered",
        });
        this.sendSystemLine(
          parent,
          `[system] subagent ${shortId(child.launch.childSessionId)} has result available`,
        );
      }

      const closureReason = child.reports.length > 0 ? "report_received" : child.closed?.reason;
      if (
        !child.classification.hasWindow &&
        !child.classification.brokerLive &&
        !child.hasOwnershipClosure &&
        closureReason
      ) {
        this.append(parent, SUBAGENT_OWNERSHIP_CLOSED_CUSTOM_TYPE, {
          writerSessionId: parent.sessionId,
          childSessionId: child.launch.childSessionId,
          reason: closureReason,
        });
      }

      if (child.state === "suspended" && restoreSuspended) {
        this.append(parent, SUBAGENT_LAUNCHED_CUSTOM_TYPE, child.launch);
        await createTmuxWindow(this.deps.executor, {
          tmuxSession,
          name: child.launch.title,
          cwd: child.launch.cwd,
          command: child.launch.resumeCommand,
          piSessionId: child.launch.childSessionId,
        });
        child.classification = {
          ...child.classification,
          cancelled: false,
          suspended: false,
          ownershipClosed: false,
        };
        runtimeChanged = true;
      } else if (child.state === "stopping") {
        this.requireCurrent(parent);
        await killTmuxWindow(this.deps.executor, tmuxSession, child.launch.childSessionId);
        runtimeChanged = true;
      }
    }

    const ownedIds = new Set(ledger.launches.map((launch) => launch.childSessionId));
    for (const window of windows) {
      if (!ownedIds.has(window.piSessionId)) {
        this.requireCurrent(parent);
        await killTmuxWindow(this.deps.executor, tmuxSession, window.piSessionId);
        runtimeChanged = true;
      }
    }

    if (runtimeChanged) {
      const [currentWindows, currentLiveSessionIds] = await Promise.all([
        listTmuxWindows(this.deps.executor, tmuxSession),
        this.deps.messaging.listSessions(),
      ]);
      const currentWindowSessionIds = new Set(currentWindows.map((window) => window.piSessionId));
      const currentLiveSessions = new Set(currentLiveSessionIds);
      for (const sessionId of currentLiveSessionIds) {
        registered.add(sessionId);
      }
      for (const child of evidence) {
        child.classification = {
          ...child.classification,
          hasWindow: currentWindowSessionIds.has(child.launch.childSessionId),
          brokerLive: currentLiveSessions.has(child.launch.childSessionId),
          hasRegistered: registered.has(child.launch.childSessionId),
        };
        child.state = classifySubagent(child.classification);
      }
    }

    return {
      states: new Map(evidence.map((child) => [child.launch.childSessionId, child.state])),
    };
  }

  private readChildEvidence(
    launch: SubagentLaunched,
    ledger: ParentSubagentLedger,
    hasWindow: boolean,
    brokerLive: boolean,
    hasRegistered: boolean,
  ): ChildEvidence {
    const lifecycle = this.readChildLifecycle(launch.childSessionFile);
    const hasOwnershipClosure = ledger.ownershipClosures.has(launch.childSessionId);
    const classification: SubagentEvidence = {
      hasWindow,
      brokerLive,
      hasRegistered,
      cancelled: ledger.cancelledChildIds.has(launch.childSessionId),
      suspended: ledger.suspendedChildIds.has(launch.childSessionId),
      hasReportOrClosure: lifecycle.reports.length > 0 || lifecycle.closed !== undefined,
      ownershipClosed: hasOwnershipClosure,
      childReadable: lifecycle.readable,
    };
    return {
      launch,
      classification,
      hasOwnershipClosure,
      reports: lifecycle.reports,
      closed: lifecycle.closed,
      state: classifySubagent(classification),
    };
  }

  private readChildLifecycle(path: string): ChildLifecycle {
    try {
      return {
        ...getChildSubagentLifecycle(this.deps.openSession(path).getBranch()),
        readable: true,
      };
    } catch {
      return { reports: [], closed: undefined, hasReminder: false, readable: false };
    }
  }

  private getRegistered(epoch: number): Set<string> {
    if (this.registered?.epoch !== epoch) {
      this.registered = { epoch, sessionIds: new Set() };
    }
    return this.registered.sessionIds;
  }

  private append(parent: ReconcileParentSession, customType: string, data: unknown): void {
    this.requireCurrent(parent);
    this.deps.executor.appendEntry(customType, data);
  }

  private sendSystemLine(parent: ReconcileParentSession, content: string): void {
    this.requireCurrent(parent);
    this.deps.executor.sendMessage({
      customType: SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
      content,
      display: true,
    });
  }

  private requireCurrent(parent: ReconcileParentSession): void {
    if (!this.deps.isCurrent(parent.epoch)) {
      throw new Error("The parent session changed during subagent reconciliation.");
    }
  }
}

export function openReconcileSession(path: string): ReconcileSessionManager {
  return SessionManager.open(path);
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}
