import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type HandoffLaunchTarget, SUBAGENT_LAUNCH } from "../session-handoff/launch-target.ts";
import { formatError } from "../shared/errors.ts";
import { createTmuxWindow, tmuxSessionName } from "../shared/tmux.ts";
import { SUBAGENT_LAUNCHED_CUSTOM_TYPE, type SubagentLaunched } from "./ledger.ts";

export interface SubagentLaunchState {
  sessionId: string;
  depth: number;
  epoch: number;
}

export function createSubagentLaunchTarget(
  pi: ExtensionAPI,
  state: SubagentLaunchState,
  isCurrent: (epoch: number) => boolean,
): HandoffLaunchTarget {
  return {
    value: SUBAGENT_LAUNCH,
    description:
      "'subagent' delegates one task to a detached tmux worker and requests a report by default.",
    requestResponseDefault: true,
    bootstrapMode: "automatic",
    approveProjectTrust: true,
    describeSubagentChild(input) {
      return {
        childSessionId: input.childSessionId,
        ownerSessionId: input.ownerSessionId,
        depth: state.depth + 1,
        requestResponse: input.requestResponse,
      };
    },
    prepareChild(input) {
      requireCurrentParent(state, input.parentSessionId, isCurrent);
    },
    async launch(input) {
      requireCurrentParent(state, input.parentSessionId, isCurrent);
      const launched: SubagentLaunched = {
        writerSessionId: state.sessionId,
        childSessionId: input.prepared.sessionId,
        childSessionFile: input.prepared.sessionFile,
        title: input.title,
        goal: input.goal,
        requestResponse: input.requestResponse,
        model: input.model,
        cwd: input.cwd,
        resumeCommand: input.prepared.resumeCommand,
        depth: state.depth + 1,
      };
      pi.appendEntry(SUBAGENT_LAUNCHED_CUSTOM_TYPE, launched);

      try {
        await createTmuxWindow(pi, {
          tmuxSession: tmuxSessionName(state.sessionId),
          name: input.title,
          cwd: input.cwd,
          command: input.prepared.resumeCommand,
          piSessionId: input.prepared.sessionId,
        });
        return { success: true, backend: "tmux" };
      } catch (error) {
        return { success: false, error: formatError(error) };
      }
    },
  };
}

function requireCurrentParent(
  state: SubagentLaunchState,
  parentSessionId: string,
  isCurrent: (epoch: number) => boolean,
): void {
  if (!isCurrent(state.epoch) || state.sessionId !== parentSessionId) {
    throw new Error("The parent session changed before subagent launch completed.");
  }
}
