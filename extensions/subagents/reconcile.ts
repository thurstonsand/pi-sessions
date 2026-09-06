import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { isSessionStarting } from "../session-handoff/metadata.ts";
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
  SUBAGENT_DISOWNED_MESSAGE_CUSTOM_TYPE,
  SUBAGENT_LAUNCHED_CUSTOM_TYPE,
  SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
  SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
  SUBAGENT_SUSPENDED_CUSTOM_TYPE,
  type SubagentLaunched,
  type SubagentReport,
  type SubagentReportMessage,
} from "./ledger.ts";
import { formatReportForModel } from "./report.ts";

export interface ReconcileParentSession {
  sessionId: string;
  epoch: number;
  getBranch(): readonly SessionEntry[];
  isIdle(): boolean;
}

export interface ReconcileSessionManager {
  getBranch(): readonly SessionEntry[];
}

export interface ReconcileMessaging {
  listSessions(): Promise<string[]>;
}

export interface ReconcileActions extends TmuxExecutor {
  appendEntry(customType: string, data: unknown): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean; details: unknown },
    options?: { triggerTurn: true } | { deliverAs: "steer" },
  ): void;
}

export interface ReconcileDependencies {
  executor: ReconcileActions;
  messaging: ReconcileMessaging;
  getParent(): ReconcileParentSession | undefined;
  isCurrent(epoch: number): boolean;
  openSession(path: string): ReconcileSessionManager;
}

interface ChildLifecycle extends ChildSubagentLifecycle {
  awaitingKickoff: boolean;
  readable: boolean;
}

interface ChildEvidence {
  launch: SubagentLaunched;
  classification: SubagentEvidence;
  state: SubagentState;
  reports: readonly SubagentReport[];
}

export interface ReconcileResult {
  states: ReadonlyMap<string, SubagentState>;
  registered: ReadonlySet<string>;
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
  private latestResult: ReconcileResult = emptyReconcileResult();
  private sentReportIds = new Set<string>();

  constructor(private readonly deps: ReconcileDependencies) {}

  beginSession(): void {
    this.shuttingDown = false;
    this.dirty = false;
    this.restoreSuspended = false;
    this.registered = undefined;
    this.latestResult = emptyReconcileResult();
    this.sentReportIds.clear();
  }

  hasSentReport(reportId: string): boolean {
    return this.sentReportIds.has(reportId);
  }

  noteReportSent(reportId: string): void {
    // Pi may queue the message before persisting it. The ledger alone cannot deduplicate it yet.
    this.sentReportIds.add(reportId);
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
      return emptyReconcileResult();
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
      this.sendDisownedMessage(parent);
    }

    for (const child of evidence) {
      if (child.state === "unknown") {
        continue;
      }

      let reportLedger: ParentSubagentLedger | undefined;
      for (const report of child.reports) {
        if (this.hasSentReport(report.reportId)) {
          continue;
        }
        // Presence and tmux awaits can yield to live delivery; read only when recovery needs it.
        reportLedger ??= collectParentLedger(parent.getBranch(), parent.sessionId);
        if (!reportLedger.receivedReportIds.has(report.reportId)) {
          this.append(parent, SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE, {
            writerSessionId: parent.sessionId,
            childSessionId: child.launch.childSessionId,
            reportId: report.reportId,
          });
        }
        if (!reportLedger.deliveredReportIds.has(report.reportId)) {
          this.deliverRecoveredReport(parent, child.launch, report);
        }
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
          awaitingKickoff: child.classification.awaitingKickoff,
        };
        child.state = classifySubagent(child.classification);
      }
    }

    return {
      states: new Map(evidence.map((child) => [child.launch.childSessionId, child.state])),
      registered: new Set(registered),
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
    const classification: SubagentEvidence = {
      hasWindow,
      brokerLive,
      hasRegistered,
      awaitingKickoff: lifecycle.awaitingKickoff,
      cancelled: ledger.cancelledChildIds.has(launch.childSessionId),
      suspended: ledger.suspendedChildIds.has(launch.childSessionId),
      hasReportOrClosure: lifecycle.reports.length > 0 || lifecycle.closed !== undefined,
      childReadable: lifecycle.readable,
    };
    return {
      launch,
      classification,
      reports: lifecycle.reports,
      state: classifySubagent(classification),
    };
  }

  private readChildLifecycle(path: string): ChildLifecycle {
    try {
      const branch = this.deps.openSession(path).getBranch();
      return {
        ...getChildSubagentLifecycle(branch),
        awaitingKickoff: isSessionStarting(branch),
        readable: true,
      };
    } catch {
      return {
        reports: [],
        closed: undefined,
        hasReminder: false,
        awaitingKickoff: false,
        readable: false,
      };
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

  private deliverRecoveredReport(
    parent: ReconcileParentSession,
    launch: SubagentLaunched,
    report: SubagentReport,
  ): void {
    const message: SubagentReportMessage = {
      writerSessionId: parent.sessionId,
      childSessionId: launch.childSessionId,
      title: launch.title,
      ...report,
      provenance: "recovered",
    };
    this.sendMessage(parent, {
      customType: SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
      content: formatReportForModel(launch.title, message),
      display: true,
      details: message,
    });
    this.noteReportSent(report.reportId);
  }

  private sendDisownedMessage(parent: ReconcileParentSession): void {
    this.requireCurrent(parent);
    this.deps.executor.sendMessage({
      customType: SUBAGENT_DISOWNED_MESSAGE_CUSTOM_TYPE,
      content:
        "[system] copied subagent records belong to the original session; this fork owns none.",
      display: true,
      details: { writerSessionId: parent.sessionId },
    });
  }

  private sendMessage(
    parent: ReconcileParentSession,
    message: { customType: string; content: string; display: boolean; details: unknown },
  ): void {
    this.requireCurrent(parent);
    const delivery = parent.isIdle()
      ? { triggerTurn: true as const }
      : { deliverAs: "steer" as const };
    this.deps.executor.sendMessage(message, delivery);
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

function emptyReconcileResult(): ReconcileResult {
  return { states: new Map(), registered: new Set() };
}
