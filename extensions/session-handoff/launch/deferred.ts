import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { LaunchBackend, LaunchInput, LaunchOutcome } from "./backend.ts";

export function createDeferredLaunchBackend(options: { copyToClipboard: boolean }): LaunchBackend {
  return {
    async launch(input: LaunchInput): Promise<LaunchOutcome> {
      if (!options.copyToClipboard) {
        return { success: true };
      }

      try {
        await copyToClipboard(input.resumeCommand);
        return { success: true, clipboardStatus: "copied" };
      } catch {
        return { success: true, clipboardStatus: "failed" };
      }
    },
  };
}
