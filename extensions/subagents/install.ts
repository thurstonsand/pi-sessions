import type {
  ExtensionAPI,
  ExtensionUIContext,
  SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import type { HandoffLaunchTarget } from "../session-handoff/launch-target.ts";
import type {
  MessagingHandle,
  SendMessageRequest,
  SendMessageResult,
} from "../session-messaging/install.ts";
import type { SessionWaker } from "../session-messaging/message-router.ts";
import type { SessionLifecycle } from "../shared/composition.ts";
import type { HerdrSession } from "../shared/herdr.ts";
import type { CompactionThresholdSettings, SessionSettings } from "../shared/settings.ts";
import { isTmuxInstalled } from "../shared/tmux.ts";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";
import { SubagentCancellationRouter, type SubagentCancelResult } from "./cancel.ts";
import { createSubagentContextLimit } from "./context-limit.ts";
import { createSubagentLaunchTarget, type SubagentLaunchState } from "./launch-target.ts";
import {
  hasSubagentLaunchEntries,
  SUBAGENT_LAUNCHED_CUSTOM_TYPE,
  SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
  SUBAGENT_REPORT_MESSAGE_SCHEMA,
  SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
} from "./ledger.ts";
import { openReconcileSession, type ReconcileResult, SubagentReconciler } from "./reconcile.ts";
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
  refreshSubagentChildState,
  type SubagentChildSessionState,
} from "./settle.ts";
import { shouldMessageSubagent } from "./should-message.ts";
import { SubagentWaker } from "./wake.ts";
import {
  createHerdrWorkerRuntime,
  createTmuxWorkerRuntime,
  type WorkerRuntime,
} from "./worker-runtime.ts";

const SUBAGENT_PROMPT_SECTION = "pi_sessions_subagent";
const SUBAGENT_PROMPT = `You are working as a subagent on one task delegated by a parent session. The handoff defines your task. Work independently, stay within its scope, and do not duplicate work assigned to the parent or another subagent. Use the available tools to complete the task and validate your conclusions. Messages from the parent may refine the task or request a follow-up, but they do not replace your original task with unrelated work.`;

interface ParentSessionState extends SubagentParentSession {
  getSessionName(): string | undefined;
  launchState: SubagentLaunchState;
  runtime: WorkerRuntime;
  canLaunchWorkers: boolean;
  getTree(): SessionTreeNode[];
  hasPendingMessages(): boolean;
  shutdown(): void;
  reportError(error: unknown): void;
}

interface CurrentSubagentSession {
  parent: ParentSessionState;
  child?: SubagentChildSessionState | undefined;
}

export interface SubagentsHandle extends SessionLifecycle {
  roster: SubagentRoster;
  waker: SessionWaker;
  getLaunchTargets(): readonly HandoffLaunchTarget[];
  sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
  cancelSession(sessionId: string): Promise<SubagentCancelResult>;
  shouldMessageSubagent(sessionId: string): Promise<boolean>;
  /** Undefined unless the active branch makes this session someone's subagent. */
  getParentSessionId(): string | undefined;
}

export function installSubagents(
  pi: ExtensionAPI,
  deps: {
    settings: SessionSettings;
    messaging: MessagingHandle;
    readCompactionSettings: (cwd: string) => CompactionThresholdSettings;
    sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
    getHerdr(): HerdrSession | undefined;
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
    messaging: deps.messaging,
    getParent: () => current?.parent,
    reconcile: () => reconciler.reconcile(),
    openSession: openRosterSession,
  });
  const waker = new SubagentWaker(deps.messaging, () => current?.parent, isCurrentSession, {
    onMaterialize: (launch) => pi.appendEntry(SUBAGENT_LAUNCHED_CUSTOM_TYPE, launch),
    afterSend: async () => {
      await reconciler.reconcile();
    },
  });
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
    if (reconciler.hasSentReport(envelope.reportId)) {
      return;
    }
    const incoming = buildIncomingSubagentReport(parent, envelope);
    if (!incoming) {
      return;
    }
    if (incoming.receipt) {
      pi.appendEntry(SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE, incoming.receipt);
    }
    deps.messaging.deliverTurnMessage({
      customType: SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
      content: incoming.content,
      display: true,
      details: incoming.message,
    });
    reconciler.noteReportSent(envelope.reportId);
  });

  pi.on("before_agent_start", (event) => {
    if (current?.child) {
      const agent = current.child.identity.agent;
      event.systemPromptOptions.sections[SUBAGENT_PROMPT_SECTION] = agent
        ? `${SUBAGENT_PROMPT}\n\n${agent.instructions}`
        : SUBAGENT_PROMPT;
    }
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "custom" || message.customType !== SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE) {
      return;
    }
    const report = safeParseTypeBoxValue(SUBAGENT_REPORT_MESSAGE_SCHEMA, message.details);
    if (report && report.writerSessionId === current?.parent.sessionId) {
      reconciler.noteReportDelivered(report.reportId);
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    settledChildLifecycle.cancel();
    if (current?.child && !current.child.paused) {
      current.child.reportsAtTurnStart = countSubagentReports(ctx.sessionManager.getBranch());
    }
  });

  pi.on("agent_settled", async (event, ctx) => {
    const session = current;
    if (!session || session.parent.sessionId !== ctx.sessionManager.getSessionId()) {
      return;
    }
    let reconciliation: ReconcileResult | undefined;
    try {
      reconciliation = hasSubagentLaunchEntries(session.parent.getBranch())
        ? await reconciler.reconcile()
        : undefined;
    } catch (error) {
      notifySubagentFailure(ctx.ui, error);
      return;
    }
    if (session.child) {
      await contextLimit.compactIfOverLimit(ctx);
      // Escape in the child's pane pauses the delegated turn; it still owes its parent a report.
      session.child.paused = event.aborted;
      if (!event.aborted) {
        await settledChildLifecycle.settle(session.parent, session.child, reconciliation);
      }
    }
  });

  const refreshChildSession = (): void => {
    if (!current) {
      return;
    }
    const previousChild = current.child;
    current.child = refreshSubagentChildState(
      current.parent.sessionId,
      current.parent.getBranch(),
      previousChild,
    );
    current.parent.launchState.depth = current.child?.identity.depth ?? 0;
    if (current.child && current.child !== previousChild) {
      pi.registerTool(
        createSubmitTaskReportTool(pi, deps.messaging, () => {
          const session = current;
          return session?.child
            ? { ...session.parent, identity: session.child.identity }
            : undefined;
        }),
      );
      const activeTools = pi.getActiveTools();
      if (!activeTools.includes("submit_task_report")) {
        pi.setActiveTools([...activeTools, "submit_task_report"]);
      }
    } else if (!current.child && previousChild) {
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "submit_task_report"));
    }
  };

  pi.on("session_tree", async (_event, ctx) => {
    settledChildLifecycle.cancel();
    refreshChildSession();
    try {
      await reconciler.reconcileAndRestoreSuspended();
    } catch (error) {
      notifySubagentFailure(ctx.ui, error);
    }
  });

  const handle: SubagentsHandle = {
    roster,
    waker,
    sendMessage: deps.sendMessage,
    cancelSession: (sessionId) => cancellationRouter.cancelSession(sessionId),
    shouldMessageSubagent: (sessionId) =>
      shouldMessageSubagent(sessionId, {
        messaging: deps.messaging,
        getParent: () => current?.parent,
        openSession: openRosterSession,
      }),
    getParentSessionId() {
      const parent = current?.parent;
      if (!parent) {
        return undefined;
      }
      return findSelfSubagentIdentity(parent.sessionId, parent.getBranch())?.ownerSessionId;
    },
    getLaunchTargets() {
      const parent = current?.parent;
      if (
        !parent?.canLaunchWorkers ||
        parent.launchState.depth >= deps.settings.subagents.maxDepth
      ) {
        return [];
      }
      return [createSubagentLaunchTarget(pi, parent.launchState, parent.runtime, isCurrentSession)];
    },
    async onSessionStart(_event, ctx) {
      settledChildLifecycle.cancel();
      epoch += 1;
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionManager = ctx.sessionManager;
      const sessionStartBranch = sessionManager.getBranch();
      const identity = findSelfSubagentIdentity(sessionId, sessionStartBranch);
      const herdr = deps.getHerdr();
      const parent: ParentSessionState = {
        sessionId,
        getSessionName: () => sessionManager.getSessionName(),
        getBranch: () => sessionManager.getBranch(),
        getTree: () => sessionManager.getTree(),
        isIdle: ctx.isIdle,
        // A message held for a compaction to finish still owes the session a turn.
        hasPendingMessages: () => ctx.hasPendingMessages() || deps.messaging.hasHeldTurnMessages(),
        shutdown: ctx.shutdown,
        epoch,
        launchState: { sessionId, depth: identity?.depth ?? 0, epoch },
        runtime: herdr ? createHerdrWorkerRuntime(herdr) : createTmuxWorkerRuntime(pi),
        canLaunchWorkers: herdr !== undefined || (await isTmuxInstalled(pi, ctx.cwd)),
        reportError: (error) => notifySubagentFailure(ctx.ui, error),
      };
      reconciler.beginSession();
      current = { parent };
      refreshChildSession();
      try {
        if (_event.reason === "reload") {
          await reconciler.reconcile();
        } else {
          await reconciler.reconcileAndRestoreSuspended();
        }
      } catch (error) {
        notifySubagentFailure(ctx.ui, error);
      }
    },
    async onSessionShutdown(event, ctx) {
      settledChildLifecycle.cancel();
      if (current && event.reason !== "reload") {
        try {
          await reconciler.suspendForShutdown();
        } catch (error) {
          notifySubagentFailure(ctx.ui, error);
        }
      }
      epoch += 1;
      current = undefined;
    },
  };
  return handle;
}

// Lifecycle hooks and timers run outside any tool call. Pi renders a thrown error's full stack
// over the conversation, so report only the message.
function notifySubagentFailure(ui: ExtensionUIContext, error: unknown): void {
  ui.notify(
    `Subagent lifecycle failed: ${error instanceof Error ? error.message : String(error)}`,
    "error",
  );
}
