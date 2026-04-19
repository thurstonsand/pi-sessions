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

export type HandoffSplitDirection = "left" | "right" | "up" | "down";

export interface CreatedHandoffSession {
  sessionId: string;
  sessionFile: string;
}

export async function validateSplitHandoffPrerequisites(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  if (!ctx.sessionManager.getSessionFile()) {
    return "Split handoff requires a persisted current session.";
  }

  if (process.env.TERM_PROGRAM !== "ghostty") {
    return "Split handoff requires running inside Ghostty.";
  }

  const result = await pi.exec("which", ["ghostty-nav"], { cwd: ctx.cwd, timeout: 5_000 });
  if (result.code !== 0) {
    return "Split handoff requires ghostty-nav on your PATH.";
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
  const result = await pi.exec(
    "ghostty-nav",
    [
      "split",
      options.direction,
      "--cwd",
      options.cwd,
      "--command",
      piCommand,
      "--focus",
      "original",
    ],
    { cwd: options.cwd, timeout: 15_000 },
  );

  if (result.code === 0) {
    return { success: true };
  }

  const details = `${result.stderr || result.stdout}`.trim() || `exit code ${result.code}`;
  return {
    success: false,
    error: `Failed to launch Ghostty split: ${details}`,
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
