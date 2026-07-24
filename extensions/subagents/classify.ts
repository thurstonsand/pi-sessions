export type SubagentState =
  | "starting"
  | "busy"
  | "active"
  | "completed"
  | "stopping"
  | "stopped"
  | "suspended"
  | "interrupted"
  | "unknown";

const RUNNING_SUBAGENT_STATES: ReadonlySet<SubagentState> = new Set(["starting", "busy", "active"]);

export interface SubagentEvidence {
  hasWindow: boolean;
  brokerLive: boolean;
  hasRegistered: boolean;
  awaitingKickoff: boolean;
  cancelled: boolean;
  suspended: boolean;
  hasReportOrClosure: boolean;
  childReadable: boolean;
}

export function isRunningSubagentState(state: SubagentState): boolean {
  return RUNNING_SUBAGENT_STATES.has(state);
}

export function classifySubagent(evidence: SubagentEvidence): SubagentState {
  if (!evidence.childReadable) {
    return "unknown";
  }
  if (evidence.hasWindow && evidence.cancelled) {
    return "stopping";
  }
  if (evidence.awaitingKickoff) {
    return "starting";
  }
  if (evidence.hasWindow && !evidence.hasRegistered) {
    return "starting";
  }
  if (evidence.hasWindow) {
    return "busy";
  }
  if (evidence.brokerLive) {
    return "active";
  }
  if (evidence.hasReportOrClosure) {
    return "completed";
  }
  if (evidence.cancelled) {
    return "stopped";
  }
  if (evidence.suspended) {
    return "suspended";
  }
  return "interrupted";
}
