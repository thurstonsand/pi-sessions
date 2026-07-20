import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CancelSessionResult } from "../session-messaging/install.ts";
import type { SubagentState } from "./classify.ts";
import {
  findOwnedSubagentLaunch,
  SUBAGENT_CANCELLED_CUSTOM_TYPE,
  type SubagentLaunched,
} from "./ledger.ts";
import type { ReconcileResult } from "./reconcile.ts";

export interface ManagedSubagentCancelResult {
  kind: "managed";
  accepted: true;
  target: {
    sessionId: string;
    sessionName?: string;
    cwd?: string;
  };
  state: SubagentState;
  cancelId?: string;
  relation?: string;
}

export type SubagentCancelResult = CancelSessionResult | ManagedSubagentCancelResult;

export interface CancelParentSession {
  sessionId: string;
  epoch: number;
  getBranch(): readonly SessionEntry[];
}

interface CancelMessaging {
  cancelSession(sessionId: string): Promise<CancelSessionResult>;
  listSessions(): Promise<string[]>;
}

interface CancelActions {
  appendEntry(customType: string, data: unknown): void;
}

interface CancelReconciler {
  reconcile(): Promise<ReconcileResult>;
}

export class SubagentCancellationRouter {
  constructor(
    private readonly executor: CancelActions,
    private readonly messaging: CancelMessaging,
    private readonly reconciler: CancelReconciler,
    private readonly getParent: () => CancelParentSession | undefined,
    private readonly isCurrent: (epoch: number) => boolean,
  ) {}

  async cancelSession(sessionId: string): Promise<SubagentCancelResult> {
    const parent = this.getParent();
    const launch = parent
      ? findOwnedSubagentLaunch(parent.getBranch(), parent.sessionId, sessionId)
      : undefined;
    if (!parent || !launch) {
      return this.messaging.cancelSession(sessionId);
    }

    return this.cancelOwned(parent, launch);
  }

  private async cancelOwned(
    parent: CancelParentSession,
    launch: SubagentLaunched,
  ): Promise<ManagedSubagentCancelResult> {
    this.requireCurrent(parent);
    this.executor.appendEntry(SUBAGENT_CANCELLED_CUSTOM_TYPE, {
      writerSessionId: parent.sessionId,
      childSessionId: launch.childSessionId,
    });

    let brokerResult: CancelSessionResult | undefined;
    if ((await this.messaging.listSessions()).includes(launch.childSessionId)) {
      this.requireCurrent(parent);
      brokerResult = await this.messaging.cancelSession(launch.childSessionId);
    }

    const reconciliation = await this.reconciler.reconcile();
    return buildManagedResult(launch, brokerResult, reconciliation);
  }

  private requireCurrent(parent: CancelParentSession): void {
    if (!this.isCurrent(parent.epoch)) {
      throw new Error("The parent session changed while cancelling its subagent.");
    }
  }
}

function buildManagedResult(
  launch: SubagentLaunched,
  brokerResult: CancelSessionResult | undefined,
  reconciliation: ReconcileResult,
): ManagedSubagentCancelResult {
  const delivered = brokerResult?.delivered ? brokerResult : undefined;
  return {
    kind: "managed",
    accepted: true,
    target: {
      sessionId: launch.childSessionId,
      sessionName: delivered?.target.sessionName ?? launch.title,
      ...(delivered?.target.cwd ? { cwd: delivered.target.cwd } : {}),
    },
    state: reconciliation.states.get(launch.childSessionId) ?? "unknown",
    ...(brokerResult ? { cancelId: brokerResult.cancelId } : {}),
    ...(delivered?.relation ? { relation: delivered.relation } : {}),
  };
}
