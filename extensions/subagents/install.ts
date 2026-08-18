import type { ExtensionAPI, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { HandoffLaunchTarget } from "../session-handoff/launch-target.ts";
import type {
  MessagingHandle,
  SendMessageRequest,
  SendMessageResult,
} from "../session-messaging/install.ts";
import type { SessionLifecycle } from "../shared/composition.ts";
import type { CompactionThresholdSettings, SessionSettings } from "../shared/settings.ts";
import { isTmuxInstalled } from "../shared/tmux.ts";
import { SubagentCancellationRouter, type SubagentCancelResult } from "./cancel.ts";
import { createSubagentContextLimit } from "./context-limit.ts";
import { createSubagentLaunchTarget, type SubagentLaunchState } from "./launch-target.ts";
import {
  hasSubagentLaunchEntries,
  SUBAGENT_LAUNCHED_CUSTOM_TYPE,
  SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
  SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
} from "./ledger.ts";
import { openReconcileSession, SubagentReconciler } from "./reconcile.ts";
import {
  buildIncomingSubagentReport,
  createSubmitTaskReportTool,
  type SubagentParentSession,
} from "./report.ts";
import { renderSubagentReportMessage } from "./report-message-renderer.ts";
import { openRosterSession, type SubagentRoster, TranscriptSubagentRoster } from "./roster.ts";
import {
  countSubagentReports,
  createSettledChildLifecycle,
  findSelfSubagentIdentity,
  type SubagentChildSessionState,
} from "./settle.ts";
import { SubagentMessageRouter } from "./wake.ts";

interface ParentSessionState extends SubagentParentSession {
  getSessionName(): string | undefined;
  launchState: SubagentLaunchState;
  tmuxInstalled: boolean;
  getTree(): SessionTreeNode[];
  hasPendingMessages(): boolean;
  shutdown(): void;
}

interface CurrentSubagentSession {
  parent: ParentSessionState;
  child?: SubagentChildSessionState | undefined;
}

export interface SubagentsHandle extends SessionLifecycle {
  roster: SubagentRoster;
  getLaunchTargets(): readonly HandoffLaunchTarget[];
  sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
  cancelSession(sessionId: string): Promise<SubagentCancelResult>;
}

export function installSubagents(
  pi: ExtensionAPI,
  deps: {
    settings: SessionSettings;
    messaging: MessagingHandle;
    readCompactionSettings: () => CompactionThresholdSettings;
  },
): SubagentsHandle {
  pi.registerMessageRenderer(SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE, renderSubagentReportMessage);

  let epoch = 0;
  let current: CurrentSubagentSession | undefined;
  const contextLimit = createSubagentContextLimit(
    deps.settings.subagents.contextLimit,
    deps.readCompactionSettings,
  );

  const isCurrentSession = (candidateEpoch: number): boolean =>
    current?.parent.epoch === candidateEpoch;
  const reconciler = new SubagentReconciler({
    executor: pi,
    messaging: deps.messaging,
    getParent: () => current?.parent,
    isCurrent: isCurrentSession,
    openSession: openReconcileSession,
  });
  const settledChildLifecycle = createSettledChildLifecycle(pi, reconciler, isCurrentSession);
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
    settledChildLifecycle.cancel();
    if (current?.child) {
      current.child.reportsAtTurnStart = countSubagentReports(ctx.sessionManager.getBranch());
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const session = current;
    if (!session || session.parent.sessionId !== ctx.sessionManager.getSessionId()) {
      return;
    }
    const reconciliation = hasSubagentLaunchEntries(session.parent.getBranch())
      ? await reconciler.reconcile()
      : undefined;
    if (session.child) {
      await contextLimit.compactIfOverLimit(ctx);
      await settledChildLifecycle.settle(session.parent, session.child, reconciliation);
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
      settledChildLifecycle.cancel();
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
                reportsAtTurnStart: countSubagentReports(sessionStartBranch),
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
      settledChildLifecycle.cancel();
      if (current && event.reason !== "reload") {
        await reconciler.suspendForShutdown();
      }
      epoch += 1;
      current = undefined;
    },
  };
}
