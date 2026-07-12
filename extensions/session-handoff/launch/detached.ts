import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { LaunchBackend, LaunchInput, LaunchOutcome } from "./backend.ts";

export function createDetachedLaunchBackend(options: { copyToClipboard: boolean }): LaunchBackend {
  return {
    async launch(input: LaunchInput): Promise<LaunchOutcome> {
      if (options.copyToClipboard) {
        try {
          await copyToClipboard(input.resumeCommand);
        } catch {
          // Best-effort side effect: the caller still owns the resume command, so a
          // clipboard failure must not fail the handoff.
        }
      }

      return { success: true };
    },
  };
}
