import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { formatError } from "../shared/errors.ts";
import type { ClipboardStatus, LaunchBackend } from "./launch/backend.ts";
import type { HandoffSubagent, HandoffSubagentAgent } from "./metadata.ts";
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

export const HANDOFF_NON_SUBAGENT_LAUNCH_SCHEMA = Type.String({
  pattern: "^(?!subagent$)[a-z][a-z0-9-]*$",
});

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
      clipboardStatus?: ClipboardStatus;
    }
  | { success: false; error: string };

/** A backend plus the handoff policy required to prepare and launch one child. */
export interface HandoffLaunchTarget {
  value: HandoffLaunchValue;
  description?: string | undefined;
  bootstrapMode: "review" | "automatic";
  /** Unattended children skip the startup trust prompt; watched ones let the user answer it. */
  approveProjectTrust: boolean;
  useDefaultSessionDir?: boolean;
  /** Tools the child keeps when an agent profile narrows its tool allowlist. */
  requiredTools?: readonly string[];
  /** Subagent launches stamp their child's identity into the child bootstrap. */
  describeSubagentChild?(input: {
    childSessionId: string;
    ownerSessionId: string;
    requestResponse: boolean;
    agent: HandoffSubagentAgent | undefined;
  }): HandoffSubagent;
  prepareChild(input: HandoffLaunchTargetPreparation): void;
  launch(input: HandoffLaunchTargetInput): Promise<HandoffLaunchTargetOutcome>;
}

export function createBackendLaunchTarget(
  value: string,
  host: LaunchBackend,
  description?: string | undefined,
): HandoffLaunchTarget {
  return {
    value,
    ...(description ? { description } : {}),
    bootstrapMode: "review",
    approveProjectTrust: false,
    prepareChild() {},
    async launch(input) {
      try {
        const result = await host.launch({
          sessionId: input.prepared.sessionId,
          sessionFile: input.prepared.sessionFile,
          cwd: input.cwd,
          title: input.title,
          model: input.model,
          resumeCommand: input.prepared.resumeCommand,
        });
        return result.success ? { ...result, backend: host.name } : result;
      } catch (error) {
        return { success: false, error: formatError(error) };
      }
    },
  };
}
