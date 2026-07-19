import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { LaunchBackend, LaunchInput } from "./backend.ts";

export function createDeferredLaunchBackend(options: { copyToClipboard: boolean }): LaunchBackend {
  return {
    name: "deferred",
    async launch(input: LaunchInput) {
      if (!options.copyToClipboard) {
        return { success: true, backend: "deferred" as const };
      }

      try {
        await copyToClipboard(input.resumeCommand);
        return { success: true, backend: "deferred" as const, clipboardStatus: "copied" as const };
      } catch {
        return { success: true, backend: "deferred" as const, clipboardStatus: "failed" as const };
      }
    },
  };
}
