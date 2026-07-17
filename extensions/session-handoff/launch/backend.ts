export interface LaunchInput {
  cwd: string;
  title: string;
  resumeCommand: string;
}

export type ClipboardStatus = "copied" | "failed";

export type LaunchOutcome =
  | { success: true; clipboardStatus?: ClipboardStatus | undefined }
  | { success: false; error: string };

export interface LaunchBackend {
  launch(input: LaunchInput): Promise<LaunchOutcome>;
}
