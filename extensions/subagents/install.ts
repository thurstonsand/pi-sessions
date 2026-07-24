import type { ExtensionAPI, SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { type HandoffLaunchTarget, SUBAGENT_LAUNCH } from "../session-handoff/launch-target.ts";
import { findCurrentHandoffBootstrap, type HandoffSubagent } from "../session-handoff/metadata.ts";
import type {
  MessagingHandle,
  SendMessageRequest,
  SendMessageResult,
} from "../session-messaging/install.ts";
import type { SessionLifecycle } from "../shared/composition.ts";
import type { SessionSettings } from "../shared/settings.ts";
import { hasAttachedTmuxClients, isTmuxInstalled, tmuxSessionName } from "../shared/tmux.ts";
import { SubagentCancellationRouter, type SubagentCancelResult } from "./cancel.ts";
import { createSubagentLaunchTarget, type SubagentLaunchState } from "./launch-target.ts";
import {
  getChildSubagentLifecycle,
  hasSubagentLaunchEntries,
  SUBAGENT_CLOSED_CUSTOM_TYPE,
  SUBAGENT_LAUNCHED_CUSTOM_TYPE,
  SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
  SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
  SUBAGENT_REPORT_REMINDER_MESSAGE_CUSTOM_TYPE,
} from "./ledger.ts";
import { openReconcileSession, SubagentReconciler } from "./reconcile.ts";
import {
  buildIncomingSubagentReport,
  createSubmitTaskReportTool,
  type SubagentParentSession,
} from "./report.ts";
import { renderSubagentReportMessage } from "./report-message-renderer.ts";
import { openRosterSession, type SubagentRoster, TranscriptSubagentRoster } from "./roster.ts";
import { SubagentMessageRouter } from "./wake.ts";

const LINGER_POLL_MS = 1_000;

interface ParentSessionState extends SubagentParentSession {
  getSessionName(): string | undefined;
  launchState: SubagentLaunchState;
  tmuxInstalled: boolean;
  getTree(): SessionTreeNode[];
  hasPendingMessages(): boolean;
  shutdown(): void;
}

interface ChildSessionState {
  identity: HandoffSubagent;
  requestResponse: boolean;
  reportsAtTurnStart: number;
}

interface CurrentSubagentSession {
  parent: ParentSessionState;
  child?: ChildSessionState | undefined;
}

export interface SubagentsHandle extends SessionLifecycle {
  roster: SubagentRoster;
  getLaunchTargets(): readonly HandoffLaunchTarget[];
  sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
  cancelSession(sessionId: string): Promise<SubagentCancelResult>;
}

export function installSubagents(
  pi: ExtensionAPI,
  deps: { settings: SessionSettings; messaging: MessagingHandle },
): SubagentsHandle {
  pi.registerMessageRenderer(SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE, renderSubagentReportMessage);

  let epoch = 0;
  let current: CurrentSubagentSession | undefined;
  let lingerTimer: NodeJS.Timeout | undefined;

  const isCurrentSession = (candidateEpoch: number): boolean =>
    current?.parent.epoch === candidateEpoch;
  const clearLinger = (): void => {
    if (lingerTimer) {
      clearTimeout(lingerTimer);
      lingerTimer = undefined;
    }
  };
  const reconciler = new SubagentReconciler({
    executor: pi,
    messaging: deps.messaging,
    getParent: () => current?.parent,
    isCurrent: isCurrentSession,
    openSession: openReconcileSession,
  });
  const roster = new TranscriptSubagentRoster({
    executor: pi,
    messaging: deps.messaging,
    getParent: () => current?.parent,
    reconcile: () => reconciler.reconcile(),
    openSession: openRosterSession,
  });
  const messageRouter = new SubagentMessageRouter(
    pi,
    deps.messaging,
    () => current?.parent,
    isCurrentSession,
    {
      onMaterialize: (launch) => pi.appendEntry(SUBAGENT_LAUNCHED_CUSTOM_TYPE, launch),
      afterOwnedSend: async () => {
        await reconciler.reconcile();
      },
    },
  );
  const cancellationRouter = new SubagentCancellationRouter(
    pi,
    deps.messaging,
    reconciler,
    () => current?.parent,
    isCurrentSession,
  );

  deps.messaging.onIncomingSubagentReport(async (envelope) => {
    const parent = current?.parent;
    if (!parent) {
      throw new Error("Target session is not ready to receive subagent reports.");
    }
    const incoming = buildIncomingSubagentReport(parent, envelope);
    if (!incoming) {
      return;
    }
    if (incoming.receipt) {
      pi.appendEntry(SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE, incoming.receipt);
    }
    pi.sendMessage(
      {
        customType: SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
        content: incoming.content,
        display: true,
        details: incoming.message,
      },
      incoming.delivery,
    );
  });

  pi.on("before_agent_start", (event) => {
    const child = current?.child;
    if (!child) {
      return;
    }
    return {
      systemPrompt: `${event.systemPrompt}

You are working as a subagent on one task delegated by a parent session. The handoff defines your task. Work independently, stay within its scope, and do not duplicate work assigned to the parent or another subagent. Use the available tools to complete the task and validate your conclusions. Messages from the parent may refine the task or request a follow-up, but they do not replace your original task with unrelated work.`,
    };
  });

  pi.on("agent_start", (_event, ctx) => {
    clearLinger();
    if (current?.child) {
      current.child.reportsAtTurnStart = countReports(ctx.sessionManager.getBranch());
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const session = current;
    if (!session || session.parent.sessionId !== ctx.sessionManager.getSessionId()) {
      return;
    }
    if (hasSubagentLaunchEntries(session.parent.getBranch())) {
      await reconciler.reconcile();
    }
    if (session.child) {
      if (ctx.hasPendingMessages()) {
        return;
      }
      const shouldExit = settleChild(pi, session.child, ctx.sessionManager.getBranch());
      if (!shouldExit) {
        return;
      }
      await exitWhenUnobserved(
        pi,
        session.parent,
        session.child.identity,
        isCurrentSession,
        (timer) => {
          clearLinger();
          lingerTimer = timer;
        },
      );
      return;
    }
  });

  pi.on("session_tree", async () => {
    await reconciler.reconcileAndRestoreSuspended();
  });

  return {
    roster,
    sendMessage: (request) => messageRouter.sendMessage(request),
    cancelSession: (sessionId) => cancellationRouter.cancelSession(sessionId),
    getLaunchTargets() {
      const parent = current?.parent;
      if (!parent?.tmuxInstalled || parent.launchState.depth >= deps.settings.subagents.maxDepth) {
        return [];
      }
      return [createSubagentLaunchTarget(pi, parent.launchState, isCurrentSession)];
    },
    async onSessionStart(_event, ctx) {
      clearLinger();
      epoch += 1;
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionManager = ctx.sessionManager;
      const sessionStartBranch = sessionManager.getBranch();
      const identity = findSelfSubagentIdentity(sessionId, sessionStartBranch);
      const parent: ParentSessionState = {
        sessionId,
        getSessionName: () => sessionManager.getSessionName(),
        getBranch: () => sessionManager.getBranch(),
        getTree: () => sessionManager.getTree(),
        isIdle: ctx.isIdle,
        hasPendingMessages: ctx.hasPendingMessages,
        shutdown: ctx.shutdown,
        epoch,
        launchState: { sessionId, depth: identity?.depth ?? 0, epoch },
        tmuxInstalled: await isTmuxInstalled(pi, ctx.cwd),
      };
      reconciler.beginSession();
      current = {
        parent,
        ...(identity
          ? {
              child: {
                identity,
                requestResponse: identity.requestResponse,
                reportsAtTurnStart: countReports(sessionStartBranch),
              },
            }
          : {}),
      };
      if (identity) {
        pi.registerTool(
          createSubmitTaskReportTool(pi, deps.messaging, () => {
            const session = current;
            return session?.child
              ? { ...session.parent, identity: session.child.identity }
              : undefined;
          }),
        );
      }
      if (_event.reason === "reload") {
        await reconciler.reconcile();
      } else {
        await reconciler.reconcileAndRestoreSuspended();
      }
    },
    async onSessionShutdown(event) {
      clearLinger();
      if (current && event.reason !== "reload") {
        await reconciler.suspendForShutdown();
      }
      epoch += 1;
      current = undefined;
    },
  };
}

function settleChild(
  pi: ExtensionAPI,
  child: ChildSessionState,
  branch: readonly SessionEntry[],
): boolean {
  const lifecycle = getChildSubagentLifecycle(branch);
  const reports = lifecycle.reports.length;
  if (reports > child.reportsAtTurnStart) {
    return true;
  }
  if (!child.requestResponse) {
    pi.appendEntry(SUBAGENT_CLOSED_CUSTOM_TYPE, {
      reason: "no_response_expected",
    });
    return true;
  }

  if (lifecycle.hasReminder) {
    pi.appendEntry(SUBAGENT_CLOSED_CUSTOM_TYPE, {
      reason: "no_report_after_reminder",
    });
    return true;
  }

  pi.sendMessage(
    {
      customType: SUBAGENT_REPORT_REMINDER_MESSAGE_CUSTOM_TYPE,
      content:
        "[system] Your delegated turn settled without a task report. Call submit_task_report now with done, blocked, or incomplete status.",
      display: true,
    },
    { triggerTurn: true },
  );
  return false;
}

function countReports(branch: readonly SessionEntry[]): number {
  return getChildSubagentLifecycle(branch).reports.length;
}

function findSelfSubagentIdentity(
  sessionId: string,
  branch: readonly SessionEntry[],
): HandoffSubagent | undefined {
  const bootstrap = findCurrentHandoffBootstrap(branch);
  if (
    bootstrap?.launch !== SUBAGENT_LAUNCH ||
    bootstrap.sessionId !== sessionId ||
    bootstrap.subagent.childSessionId !== sessionId
  ) {
    return undefined;
  }
  return bootstrap.subagent;
}

async function exitWhenUnobserved(
  executor: ExtensionAPI,
  parent: ParentSessionState,
  identity: HandoffSubagent,
  isCurrentSession: (epoch: number) => boolean,
  setTimer: (timer: NodeJS.Timeout) => void,
): Promise<void> {
  const check = async (): Promise<void> => {
    if (!isCurrentSession(parent.epoch) || parent.hasPendingMessages() || !parent.isIdle()) {
      return;
    }

    let attached = false;
    try {
      attached = await hasAttachedTmuxClients(executor, tmuxSessionName(identity.ownerSessionId));
    } catch {
      attached = false;
    }
    if (!isCurrentSession(parent.epoch)) {
      return;
    }
    if (!attached) {
      parent.shutdown();
      return;
    }
    setTimer(setTimeout(() => void check(), LINGER_POLL_MS));
  };

  await check();
}
