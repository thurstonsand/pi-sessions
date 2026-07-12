import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LaunchBackend, LaunchInput, LaunchOutcome } from "./backend.ts";
import { escapeAppleScriptString, shellQuote } from "./shell.ts";

const GHOSTTY_MACOS_ONLY_MESSAGE = "Split handoff currently supports Ghostty on macOS only.";
const GHOSTTY_REQUIRED_MESSAGE = "Split handoff requires running inside Ghostty.";
const GHOSTTY_SPLIT_TIMEOUT_MS = 15_000;
const OSASCRIPT_PATH = "/usr/bin/osascript";

export type HandoffSplitDirection = "left" | "right" | "up" | "down";

export interface GhosttyLaunchConfig {
  direction: HandoffSplitDirection;
  terminalId?: string | undefined;
  fallbackToFocusedOnError?: boolean | undefined;
}

export function isGhosttyHandoffAvailable(): boolean {
  return process.platform === "darwin" && process.env.TERM_PROGRAM === "ghostty";
}

export async function validateSplitHandoffPrerequisites(
  ctx: ExtensionContext,
): Promise<string | undefined> {
  if (!ctx.sessionManager.getSessionFile()) {
    return "Split handoff requires a persisted current session.";
  }

  if (process.platform !== "darwin") {
    return GHOSTTY_MACOS_ONLY_MESSAGE;
  }

  if (process.env.TERM_PROGRAM !== "ghostty") {
    return GHOSTTY_REQUIRED_MESSAGE;
  }

  return undefined;
}

export async function getFocusedGhosttyTerminalId(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string | undefined> {
  const appleScript = [
    'tell application "Ghostty"',
    "    get id of focused terminal of selected tab of front window",
    "end tell",
  ].join("\n");
  const result = await pi.exec(OSASCRIPT_PATH, ["-e", appleScript], {
    cwd,
    timeout: GHOSTTY_SPLIT_TIMEOUT_MS,
  });

  if (result.code !== 0) {
    return undefined;
  }

  return result.stdout.trim() || undefined;
}

export function createGhosttyLaunchBackend(
  pi: ExtensionAPI,
  config: GhosttyLaunchConfig,
): LaunchBackend {
  return {
    async launch(input: LaunchInput): Promise<LaunchOutcome> {
      const first = await runGhosttySplit(pi, config, config.terminalId, input);
      if (first.success || !config.terminalId || !config.fallbackToFocusedOnError) {
        return first;
      }

      return runGhosttySplit(pi, config, undefined, input);
    },
  };
}

async function runGhosttySplit(
  pi: ExtensionAPI,
  config: GhosttyLaunchConfig,
  terminalId: string | undefined,
  input: LaunchInput,
): Promise<LaunchOutcome> {
  const escapedCwd = escapeAppleScriptString(input.cwd);
  const escapedCommand = escapeAppleScriptString(buildGhosttyShellCommand(input.resumeCommand));
  const targetTerminalLine = terminalId
    ? `    set targetTerminal to item 1 of (every terminal whose id is "${escapeAppleScriptString(terminalId)}")`
    : "    set targetTerminal to focused terminal of selected tab of front window";
  const appleScript = [
    'tell application "Ghostty"',
    targetTerminalLine,
    "    set cfg to new surface configuration",
    `    set initial working directory of cfg to "${escapedCwd}"`,
    `    set command of cfg to "${escapedCommand}"`,
    `    set newTerminal to split targetTerminal direction ${config.direction} with configuration cfg`,
    "end tell",
  ].join("\n");
  const result = await pi.exec(OSASCRIPT_PATH, ["-e", appleScript], {
    cwd: input.cwd,
    timeout: GHOSTTY_SPLIT_TIMEOUT_MS,
  });

  if (result.code === 0) {
    return { success: true };
  }

  const details = `${result.stderr || result.stdout}`.trim() || `exit code ${result.code}`;
  return {
    success: false,
    error: `Failed to launch Ghostty split: ${details}. ${GHOSTTY_MACOS_ONLY_MESSAGE}`,
  };
}

function buildGhosttyShellCommand(resumeCommand: string): string {
  const payload = `${resumeCommand}; exec /bin/zsh -il`;
  return `/bin/zsh -ilc ${shellQuote(payload)}`;
}
