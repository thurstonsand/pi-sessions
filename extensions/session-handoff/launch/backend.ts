export interface LaunchInput {
  cwd: string;
  title: string;
  resumeCommand: string;
}

export type LaunchOutcome = { success: true } | { success: false; error: string };

export interface LaunchBackend {
  launch(input: LaunchInput): Promise<LaunchOutcome>;
}
