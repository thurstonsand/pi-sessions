import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionHeader,
} from "@mariozechner/pi-coding-agent";
import { HANDOFF_BOOTSTRAP_ENV } from "./metadata.js";

const GHOSTTY_MACOS_ONLY_MESSAGE = "Split handoff currently supports Ghostty on macOS only.";
const GHOSTTY_REQUIRED_MESSAGE = "Split handoff requires running inside Ghostty.";
const GHOSTTY_SPLIT_TIMEOUT_MS = 15_000;
const OSASCRIPT_PATH = "/usr/bin/osascript";

export type HandoffSplitDirection = "left" | "right" | "up" | "down";

export interface CreatedHandoffSession {
  sessionId: string;
  sessionFile: string;
}

export async function validateSplitHandoffPrerequisites(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
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

export function createHandoffSession(options: {
  cwd: string;
  sessionDir: string;
  parentSessionFile: string;
}): CreatedHandoffSession {
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionFile = join(options.sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);

  const header: SessionHeader = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: options.cwd,
    parentSession: options.parentSessionFile,
  };

  writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);

  return { sessionId, sessionFile };
}

export async function launchSplitHandoffSession(
  pi: ExtensionAPI,
  options: {
    cwd: string;
    sessionDir: string;
    direction: HandoffSplitDirection;
    sessionId: string;
    bootstrapValue: string;
  },
): Promise<{ success: true } | { success: false; error: string }> {
  const piCommand = buildPiLaunchCommand(
    options.sessionDir,
    options.sessionId,
    options.bootstrapValue,
  );
  const escapedCwd = escapeAppleScriptString(options.cwd);
  const escapedCommand = escapeAppleScriptString(piCommand);
  const appleScript = [
    'tell application "Ghostty"',
    "    set targetTerminal to focused terminal of selected tab of front window",
    "    set cfg to new surface configuration",
    `    set initial working directory of cfg to "${escapedCwd}"`,
    `    set command of cfg to "${escapedCommand}"`,
    `    set newTerminal to split targetTerminal direction ${options.direction} with configuration cfg`,
    "    focus targetTerminal",
    "end tell",
  ].join("\n");
  const result = await pi.exec(OSASCRIPT_PATH, ["-e", appleScript], {
    cwd: options.cwd,
    timeout: GHOSTTY_SPLIT_TIMEOUT_MS,
  });

  if (result.code === 0) {
    return { success: true };
  }

  const details = `${result.stderr || result.stdout}`.trim() || `exit code ${result.code}`;
  return {
    success: false,
    error:
      `Failed to launch Ghostty split: ${details}. ` +
      "Split handoff currently supports Ghostty on macOS only.",
  };
}

export function buildPiResumeCommand(
  sessionDir: string,
  sessionId: string,
  bootstrapValue: string,
): string {
  return [
    `${HANDOFF_BOOTSTRAP_ENV}=${shellQuote(bootstrapValue)}`,
    "pi",
    "--session-dir",
    shellQuote(sessionDir),
    "--session",
    shellQuote(sessionId),
  ].join(" ");
}

export function buildPiLaunchCommand(
  sessionDir: string,
  sessionId: string,
  bootstrapValue: string,
): string {
  const payload = `${buildPiResumeCommand(sessionDir, sessionId, bootstrapValue)}; exec /bin/zsh -il`;
  return `/bin/zsh -ilc ${shellQuote(payload)}`;
}

function escapeAppleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
