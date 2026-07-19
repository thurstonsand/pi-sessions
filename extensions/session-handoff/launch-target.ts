import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ClipboardStatus, HandoffSplitDirection, LaunchBackend } from "./launch/backend.ts";
import type { PreparedHandoff } from "./spawn.ts";

export const LAUNCH_DIRECTIONS = ["left", "right", "up", "down"] as const;
export const DEFERRED_LAUNCH = "deferred" as const;
export const SUBAGENT_LAUNCH = "subagent" as const;

export type HandoffLaunchValue =
  | HandoffSplitDirection
  | typeof DEFERRED_LAUNCH
  | typeof SUBAGENT_LAUNCH;

export interface HandoffLaunchTargetPreparation {
  manager: SessionManager;
  childSessionId: string;
  parentSessionId: string;
  parentSessionFile: string;
  requestResponse: boolean;
}

export interface HandoffLaunchTargetInput {
  prepared: PreparedHandoff;
  parentSessionId: string;
  title: string;
  goal: string;
  requestResponse: boolean;
  model: string;
  cwd: string;
}

export type HandoffLaunchTargetOutcome =
  | {
      success: true;
      backend: string;
      clipboardStatus?: ClipboardStatus | undefined;
    }
  | { success: false; error: string };

/** A backend plus the handoff policy required to prepare and launch one child. */
export interface HandoffLaunchTarget {
  value: HandoffLaunchValue;
  description?: string | undefined;
  requestResponseDefault: boolean;
  bootstrapMode: "review" | "automatic";
  prepareChild(input: HandoffLaunchTargetPreparation): void;
  launch(input: HandoffLaunchTargetInput): Promise<HandoffLaunchTargetOutcome>;
}

export function createBackendLaunchTarget(
  value: HandoffSplitDirection | "deferred",
  backend: LaunchBackend,
  description?: string | undefined,
): HandoffLaunchTarget {
  return {
    value,
    ...(description ? { description } : {}),
    requestResponseDefault: false,
    bootstrapMode: "review",
    prepareChild() {},
    launch(input) {
      return backend.launch({
        cwd: input.cwd,
        title: input.title,
        resumeCommand: input.prepared.resumeCommand,
      });
    },
  };
}
