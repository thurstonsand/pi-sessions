import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isInsideTmux } from "../../shared/tmux.ts";
import type { HandoffSplitDirection, LaunchBackend } from "./backend.ts";
import {
  createGhosttyLaunchBackend,
  getFocusedGhosttyTerminalId,
  isGhosttyHandoffAvailable,
} from "./ghostty.ts";
import { createTmuxSplitLaunchBackend } from "./tmux.ts";

export interface SplitLaunchBackend {
  name: string;
  create(direction: HandoffSplitDirection): LaunchBackend;
  identifyTerminalId?(cwd: string): Promise<string | undefined>;
}

export function resolveSplitLaunchBackend(
  pi: ExtensionAPI,
  options: {
    getTerminalId: () => string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
  },
): SplitLaunchBackend | undefined {
  const env = options.env ?? process.env;
  if (isInsideTmux(env)) {
    return {
      name: "tmux",
      create: (direction) => createTmuxSplitLaunchBackend(pi, direction),
    };
  }
  if (!isGhosttyHandoffAvailable(env)) {
    return undefined;
  }
  return {
    name: "Ghostty",
    identifyTerminalId: (cwd) => getFocusedGhosttyTerminalId(pi, cwd),
    create(direction) {
      return createGhosttyLaunchBackend(pi, {
        direction,
        terminalId: options.getTerminalId(),
      });
    },
  };
}

export function validateSplitHandoffPrerequisites(
  ctx: ExtensionContext,
  backend: SplitLaunchBackend | undefined,
): string | undefined {
  if (!ctx.sessionManager.getSessionFile()) {
    return "Split handoff requires a persisted current session.";
  }
  if (!backend) {
    return "Split handoff requires running inside tmux or Ghostty on macOS.";
  }
  return undefined;
}
