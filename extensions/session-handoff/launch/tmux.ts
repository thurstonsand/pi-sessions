import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HandoffSplitDirection, LaunchBackend, LaunchInput } from "./backend.ts";

const TMUX_SPLIT_TIMEOUT_MS = 15_000;

export function createTmuxSplitLaunchBackend(
  pi: ExtensionAPI,
  direction: HandoffSplitDirection,
): LaunchBackend {
  return {
    name: "tmux",
    async launch(input: LaunchInput) {
      const result = await pi.exec("tmux", splitArgs(direction, input), {
        cwd: input.cwd,
        timeout: TMUX_SPLIT_TIMEOUT_MS,
      });
      if (result.code === 0) {
        return { success: true, backend: "tmux" as const };
      }

      const details = `${result.stderr || result.stdout}`.trim() || `exit code ${result.code}`;
      return { success: false, error: `Failed to launch tmux split: ${details}.` };
    },
  };
}

function splitArgs(direction: HandoffSplitDirection, input: LaunchInput): string[] {
  const orientation = direction === "left" || direction === "right" ? "-h" : "-v";
  const before = direction === "left" || direction === "up" ? ["-b"] : [];
  return ["split-window", orientation, ...before, "-d", "-c", input.cwd, input.resumeCommand];
}
