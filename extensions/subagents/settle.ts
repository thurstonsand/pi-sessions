import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_LAUNCH } from "../session-handoff/launch-target.ts";
import { findCurrentHandoffBootstrap, type HandoffSubagent } from "../session-handoff/metadata.ts";
import { hasAttachedTmuxClients, tmuxSessionName } from "../shared/tmux.ts";
import { isRunningSubagentState } from "./classify.ts";
import {
  getChildSubagentLifecycle,
  SUBAGENT_CLOSED_CUSTOM_TYPE,
  SUBAGENT_REPORT_REMINDER_MESSAGE_CUSTOM_TYPE,
} from "./ledger.ts";
import type { ReconcileResult, SubagentReconciler } from "./reconcile.ts";

const LINGER_POLL_MS = 1_000;
const OWNED_SUBAGENT_POLL_MS = 10_000;

export interface SubagentChildSessionState {
  identity: HandoffSubagent;
  requestResponse: boolean;
  reportsAtTurnStart: number;
}

export interface SettledChildParentSession {
  epoch: number;
  getBranch(): readonly SessionEntry[];
  hasPendingMessages(): boolean;
  isIdle(): boolean;
  shutdown(): void;
}

export interface SettledChildLifecycle {
  cancel(): void;
  settle(
    parent: SettledChildParentSession,
    child: SubagentChildSessionState,
    reconciliation: ReconcileResult | undefined,
  ): Promise<void>;
}

export function createSettledChildLifecycle(
  pi: ExtensionAPI,
  reconciler: SubagentReconciler,
  isCurrentSession: (epoch: number) => boolean,
): SettledChildLifecycle {
  let generation = 0;
  let timer: NodeJS.Timeout | undefined;

  const cancel = (): void => {
    generation += 1;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    cancel,
    async settle(parent, child, reconciliation) {
      cancel();
      const currentGeneration = generation;
      let phase: "owned-subagents" | "settle" | "observer" =
        reconciliation && hasRunningOwnedSubagents(reconciliation) ? "owned-subagents" : "settle";
      const canAdvance = (): boolean =>
        generation === currentGeneration &&
        isCurrentSession(parent.epoch) &&
        !parent.hasPendingMessages() &&
        parent.isIdle();
      const schedule = (delayMs: number): void => {
        timer = setTimeout(() => {
          timer = undefined;
          void advance();
        }, delayMs);
      };
      const advance = async (): Promise<void> => {
        if (!canAdvance()) {
          return;
        }

        if (phase === "owned-subagents") {
          const result = await reconciler.reconcile();
          if (!canAdvance()) {
            return;
          }
          if (hasRunningOwnedSubagents(result)) {
            schedule(OWNED_SUBAGENT_POLL_MS);
            return;
          }
          phase = "settle";
        }

        if (phase === "settle") {
          if (!settleChild(pi, child, parent.getBranch())) {
            return;
          }
          phase = "observer";
        }

        let attached = false;
        try {
          attached = await hasAttachedTmuxClients(
            pi,
            tmuxSessionName(child.identity.ownerSessionId),
          );
        } catch {
          attached = false;
        }
        if (!canAdvance()) {
          return;
        }
        if (!attached) {
          parent.shutdown();
          return;
        }
        schedule(LINGER_POLL_MS);
      };

      if (phase === "owned-subagents") {
        schedule(OWNED_SUBAGENT_POLL_MS);
        return;
      }
      await advance();
    },
  };
}

export function countSubagentReports(branch: readonly SessionEntry[]): number {
  return getChildSubagentLifecycle(branch).reports.length;
}

export function findSelfSubagentIdentity(
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

function hasRunningOwnedSubagents(result: ReconcileResult): boolean {
  return [...result.states.values()].some(isRunningSubagentState);
}

function settleChild(
  pi: ExtensionAPI,
  child: SubagentChildSessionState,
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
