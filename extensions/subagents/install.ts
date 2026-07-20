import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HandoffLaunchTarget } from "../session-handoff/launch-target.ts";
import type {
  MessagingHandle,
  SendMessageRequest,
  SendMessageResult,
} from "../session-messaging/install.ts";
import type { SessionLifecycle } from "../shared/composition.ts";
import type { SessionSettings } from "../shared/settings.ts";
import { hasAttachedTmuxClients, isTmuxInstalled, tmuxSessionName } from "../shared/tmux.ts";
import { findSubagentIdentity, type SubagentIdentity } from "./identity.ts";
import { createSubagentLaunchTarget, type SubagentLaunchState } from "./launch-target.ts";
import { SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE } from "./ledger.ts";
import {
  buildIncomingSubagentReport,
  createSubmitTaskReportTool,
  SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
  type SubagentParentSession,
} from "./report.ts";
import { SubagentMessageRouter } from "./wake.ts";

const LINGER_POLL_MS = 1_000;

interface ParentSessionState extends SubagentParentSession {
  launchState: SubagentLaunchState;
  tmuxInstalled: boolean;
  hasPendingMessages(): boolean;
  shutdown(): void;
}

interface ChildSessionState {
  identity: SubagentIdentity;
  requestResponse: boolean;
}

interface CurrentSubagentSession {
  parent: ParentSessionState;
  child?: ChildSessionState | undefined;
}

export interface SubagentsHandle extends SessionLifecycle {
  getLaunchTargets(): readonly HandoffLaunchTarget[];
  sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
}

export function installSubagents(
  pi: ExtensionAPI,
  deps: { settings: SessionSettings; messaging: MessagingHandle },
): SubagentsHandle {
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
  const messageRouter = new SubagentMessageRouter(
    pi,
    deps.messaging,
    () => current?.parent,
    isCurrentSession,
  );

  deps.messaging.onIncomingSubagentReport((envelope) => {
    const parent = current?.parent;
    if (!parent) {
      throw new Error("Target session is not ready to receive subagent reports.");
    }
    const incoming = buildIncomingSubagentReport(parent, envelope);
    if (!incoming) {
      return;
    }
    pi.appendEntry(SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE, incoming.receipt);
    pi.sendMessage(
      {
        customType: SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
        content: incoming.content,
        display: true,
        details: incoming.receipt,
      },
      incoming.delivery,
    );
  });

  pi.on("before_agent_start", (event) => {
    const child = current?.child;
    if (!child) {
      return;
    }
    const reportInstructions = child.requestResponse
      ? " When the task or requested follow-up reaches a terminal state, call submit_task_report exactly once as your final action. Report whether the work is done, blocked, or incomplete, and include enough evidence and context for the parent to act without reconstructing your investigation. Do not use session_send_message for task reports and do not end a turn with ordinary prose alone."
      : "";
    return {
      systemPrompt: `${event.systemPrompt}

You are working as a subagent on one task delegated by a parent session. The handoff defines your task. Work independently, stay within its scope, and do not duplicate work assigned to the parent or another subagent. Use the available tools to complete the task and validate your conclusions. Messages from the parent may refine the task or request a follow-up, but they do not replace your original task with unrelated work.${reportInstructions}`,
    };
  });

  pi.on("agent_start", () => {
    clearLinger();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const session = current;
    if (!session?.child || session.parent.sessionId !== ctx.sessionManager.getSessionId()) {
      return;
    }
    if (ctx.hasPendingMessages()) {
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
  });

  return {
    sendMessage: (request) => messageRouter.sendMessage(request),
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
      const identity = findSubagentIdentity(ctx.sessionManager.getBranch(), sessionId);
      const sessionManager = ctx.sessionManager;
      const parent: ParentSessionState = {
        sessionId,
        getBranch: () => sessionManager.getBranch(),
        isIdle: ctx.isIdle,
        hasPendingMessages: ctx.hasPendingMessages,
        shutdown: ctx.shutdown,
        epoch,
        launchState: { sessionId, depth: identity?.depth ?? 0, epoch },
        tmuxInstalled: await isTmuxInstalled(pi, ctx.cwd),
      };
      current = {
        parent,
        ...(identity ? { child: { identity, requestResponse: identity.requestResponse } } : {}),
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
    },
    onSessionShutdown() {
      clearLinger();
      epoch += 1;
      current = undefined;
    },
  };
}

async function exitWhenUnobserved(
  executor: ExtensionAPI,
  parent: ParentSessionState,
  identity: SubagentIdentity,
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
