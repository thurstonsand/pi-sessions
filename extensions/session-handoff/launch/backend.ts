export type HandoffSplitDirection = "left" | "right" | "up" | "down";

export interface LaunchInput {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  title: string;
  model: string;
  resumeCommand: string;
}

export type ClipboardStatus = "copied" | "failed";

export interface LaunchBackend {
  name: string;
  launch(
    input: LaunchInput,
  ): Promise<
    { success: true; clipboardStatus?: ClipboardStatus } | { success: false; error: string }
  >;
}
