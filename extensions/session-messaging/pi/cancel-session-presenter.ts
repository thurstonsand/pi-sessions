import type { CancelSessionToolDetails, ReceivedMessageEndpoint } from "./message-contracts.ts";

const CONFIRMED_MANAGED_STATES = new Set(["active", "completed", "stopped", "stopping"]);

export function isConfirmedManagedCancellation(state: string): boolean {
  return CONFIRMED_MANAGED_STATES.has(state);
}

export function buildCancelSessionModelText(details: CancelSessionToolDetails): string {
  return buildCancelSessionText(details, modelTarget(details.target));
}

export function buildCancelSessionUserText(details: CancelSessionToolDetails): string {
  return buildCancelSessionText(details, userTarget(details.target));
}

export function buildUnknownCancellationError(target: ReceivedMessageEndpoint): string {
  return `Could not confirm cancellation of subagent ${userTarget(target)}.\nsession ${target.sessionId}`;
}

export function buildDeadSessionError(sessionId: string): string {
  return `No running session found: ${sessionId}.\nThe target is not an owned subagent and has no broker-live process to cancel.`;
}

export function buildCancelSessionUserError(content: string, expanded: boolean): string {
  if (
    !content.startsWith("No running session found:") &&
    !content.startsWith("Could not confirm cancellation of subagent")
  ) {
    return content;
  }

  const [summary = content, ...details] = content.split("\n");
  const session = details.find((line) => line.startsWith("session "));
  return expanded && session ? `${summary}\n${session}` : summary;
}

function buildCancelSessionText(details: CancelSessionToolDetails, target: string): string {
  if (details.kind === "transport") {
    return `Cancellation sent to session ${target}.`;
  }

  switch (details.state) {
    case "stopped":
      return `Stopped subagent ${target}.`;
    case "active":
    case "stopping":
      return `Stop requested for subagent ${target}; it is still shutting down.`;
    case "completed":
      return `Subagent ${target} already completed.`;
    default:
      return `Could not confirm cancellation of subagent ${target}.`;
  }
}

function userTarget(target: ReceivedMessageEndpoint): string {
  return target.sessionName ? `"${target.sessionName}"` : target.sessionId;
}

function modelTarget(target: ReceivedMessageEndpoint): string {
  return target.sessionName
    ? `"${target.sessionName}" (session: ${target.sessionId})`
    : target.sessionId;
}
