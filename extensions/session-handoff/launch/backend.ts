import type { HandoffLaunchTargetOutcome } from "../launch-target.ts";

export type HandoffSplitDirection = "left" | "right" | "up" | "down";

export interface LaunchInput {
  cwd: string;
  title: string;
  resumeCommand: string;
}

export type ClipboardStatus = "copied" | "failed";

export interface LaunchBackend {
  name: string;
  launch(input: LaunchInput): Promise<HandoffLaunchTargetOutcome>;
}
