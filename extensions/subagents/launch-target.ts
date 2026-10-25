import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type HandoffLaunchTarget, SUBAGENT_LAUNCH } from "../session-handoff/launch-target.ts";
import { formatError } from "../shared/errors.ts";
import { SUBAGENT_LAUNCHED_CUSTOM_TYPE, type SubagentLaunched } from "./ledger.ts";
import type { WorkerRuntime } from "./worker-runtime.ts";

export interface SubagentLaunchState {
  sessionId: string;
  depth: number;
  epoch: number;
}

export function createSubagentLaunchTarget(
  pi: ExtensionAPI,
  state: SubagentLaunchState,
  runtime: WorkerRuntime,
  isCurrent: (epoch: number) => boolean,
): HandoffLaunchTarget {
  return {
    value: SUBAGENT_LAUNCH,
    description: `'subagent' delegates one task to a detached ${runtime.name} worker and requests a report by default.`,
    bootstrapMode: "automatic",
    approveProjectTrust: true,
    requiredTools: ["submit_task_report"],
    describeSubagentChild(input) {
      return {
        childSessionId: input.childSessionId,
        ownerSessionId: input.ownerSessionId,
        depth: state.depth + 1,
        requestResponse: input.requestResponse,
        ...(input.agent ? { agent: input.agent } : {}),
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
        await runtime.create(state.sessionId, {
          name: input.title,
          cwd: input.cwd,
          command: input.prepared.resumeCommand,
          piSessionId: input.prepared.sessionId,
        });
        return { success: true, backend: runtime.name };
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
