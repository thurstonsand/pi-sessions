import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionHeader,
  type SessionInfoEntry,
} from "@earendil-works/pi-coding-agent";
import { HANDOFF_BOOTSTRAP_ENV } from "./metadata.ts";

const GHOSTTY_MACOS_ONLY_MESSAGE = "Split handoff currently supports Ghostty on macOS only.";
const GHOSTTY_REQUIRED_MESSAGE = "Split handoff requires running inside Ghostty.";
const GHOSTTY_SPLIT_TIMEOUT_MS = 15_000;
const OSASCRIPT_PATH = "/usr/bin/osascript";

export type HandoffSplitDirection = "left" | "right" | "up" | "down";

export interface CreatedHandoffSession {
  sessionId: string;
  sessionFile: string;
}

export function isGhosttyHandoffAvailable(): boolean {
  return process.platform === "darwin" && process.env.TERM_PROGRAM === "ghostty";
}

export async function validateSplitHandoffPrerequisites(
  _pi: ExtensionAPI,
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

export function createHandoffSession(options: {
  cwd: string;
  sessionDir: string;
  parentSessionFile: string;
  title: string;
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

  const titleEntry: SessionInfoEntry = {
    type: "session_info",
    id: randomUUID(),
    parentId: null,
    timestamp,
    name: options.title,
  };

  writeFileSync(
    sessionFile,
    `${[JSON.stringify(header), JSON.stringify(titleEntry)].join("\n")}\n`,
  );

  return { sessionId, sessionFile };
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

export async function launchSplitHandoffSession(
  pi: ExtensionAPI,
  options: {
    cwd: string;
    sessionDir: string;
    direction: HandoffSplitDirection;
    sessionId: string;
    bootstrapValue: string;
    title: string;
    terminalId?: string | undefined;
    restoreFocus?: boolean | undefined;
    model?: string | undefined;
  },
): Promise<{ success: true } | { success: false; error: string }> {
  const piCommand = buildPiLaunchCommand({
    sessionDir: options.sessionDir,
    sessionId: options.sessionId,
    bootstrapValue: options.bootstrapValue,
    title: options.title,
    model: options.model,
  });
  const escapedCwd = escapeAppleScriptString(options.cwd);
  const escapedCommand = escapeAppleScriptString(piCommand);
  const targetTerminalLine = options.terminalId
    ? `    set targetTerminal to item 1 of (every terminal whose id is "${escapeAppleScriptString(options.terminalId)}")`
    : "    set targetTerminal to focused terminal of selected tab of front window";
  const focusLine = options.restoreFocus === false ? [] : ["    focus targetTerminal"];
  const appleScript = [
    'tell application "Ghostty"',
    targetTerminalLine,
    "    set cfg to new surface configuration",
    `    set initial working directory of cfg to "${escapedCwd}"`,
    `    set command of cfg to "${escapedCommand}"`,
    `    set newTerminal to split targetTerminal direction ${options.direction} with configuration cfg`,
    ...focusLine,
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
  title: string,
  model?: string | undefined,
): string {
  const args = [
    `${HANDOFF_BOOTSTRAP_ENV}=${shellQuote(bootstrapValue)}`,
    "pi",
    "--session-dir",
    shellQuote(sessionDir),
    "--session-id",
    shellQuote(sessionId),
    "--name",
    shellQuote(title),
  ];

  if (model) {
    args.push("--model", shellQuote(model));
  }

  return args.join(" ");
}

export function buildPiLaunchCommand(options: {
  sessionDir: string;
  sessionId: string;
  bootstrapValue: string;
  title: string;
  model?: string | undefined;
}): string {
  const payload = `${buildPiResumeCommand(
    options.sessionDir,
    options.sessionId,
    options.bootstrapValue,
    options.title,
    options.model,
  )}; exec /bin/zsh -il`;
  return `/bin/zsh -ilc ${shellQuote(payload)}`;
}

function escapeAppleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
