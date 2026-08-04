import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { ClipboardStatus, HandoffSplitDirection, LaunchBackend } from "./launch/backend.ts";
import type { HandoffSubagent } from "./metadata.ts";
import type { PreparedHandoff } from "./spawn.ts";

export const DEFERRED_LAUNCH = "deferred" as const;
export const SUBAGENT_LAUNCH = "subagent" as const;

export const LAUNCH_DIRECTIONS = ["left", "right", "up", "down"] as const;
export const HANDOFF_DIRECTION_LAUNCH_SCHEMA = Type.Union([
  Type.Literal("left"),
  Type.Literal("right"),
  Type.Literal("up"),
  Type.Literal("down"),
]);

export const HANDOFF_NON_SUBAGENT_LAUNCH_SCHEMA = Type.Union([
  HANDOFF_DIRECTION_LAUNCH_SCHEMA,
  Type.Literal(DEFERRED_LAUNCH),
]);

export const HANDOFF_LAUNCH_VALUE_SCHEMA = Type.Union([
  HANDOFF_NON_SUBAGENT_LAUNCH_SCHEMA,
  Type.Literal(SUBAGENT_LAUNCH),
]);

export type HandoffLaunchValue = Static<typeof HANDOFF_LAUNCH_VALUE_SCHEMA>;

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
  /** Unattended children skip the startup trust prompt; watched ones let the user answer it. */
  approveProjectTrust: boolean;
  /** Subagent launches stamp their child's identity into the child bootstrap. */
  describeSubagentChild?(input: {
    childSessionId: string;
    ownerSessionId: string;
    requestResponse: boolean;
  }): HandoffSubagent;
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
    approveProjectTrust: false,
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
