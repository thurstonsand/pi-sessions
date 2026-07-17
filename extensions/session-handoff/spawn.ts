import { writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { shellQuote } from "./launch/shell.ts";
import { HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE, type HandoffBootstrap } from "./metadata.ts";

export interface PreparedHandoff {
  sessionId: string;
  sessionFile: string;
  resumeCommand: string;
}

/**
 * Owns the backend-independent half of a handoff: create the prepared child
 * session (bootstrap included) and build the self-locating resume command
 * every failure path must surface.
 */
export function prepareHandoffLaunch(options: {
  targetCwd: string;
  parentCwd: string;
  parentSessionDir: string;
  parentSessionFile: string;
  title: string;
  model: string | undefined;
  buildBootstrap: (sessionId: string) => HandoffBootstrap;
}): PreparedHandoff {
  // Same-cwd children stay in the parent's session directory, preserving a
  // deliberate nondefault dir. Cross-cwd children live with their target
  // project, so Pi computes that project's default storage location.
  const sameCwd = options.targetCwd === options.parentCwd;
  const manager = SessionManager.create(
    options.targetCwd,
    sameCwd ? options.parentSessionDir : undefined,
    { parentSession: options.parentSessionFile },
  );
  manager.appendSessionInfo(options.title);
  manager.appendCustomEntry(
    HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
    options.buildBootstrap(manager.getSessionId()),
  );
  flushPreparedSession(manager);

  const sessionFile = manager.getSessionFile();
  if (!sessionFile) {
    throw new Error("Prepared handoff session has no session file.");
  }

  const resumeCommand = buildPiResumeCommand({
    targetCwd: options.targetCwd,
    parentCwd: options.parentCwd,
    sessionId: manager.getSessionId(),
    sessionDir: manager.usesDefaultSessionDir() ? undefined : manager.getSessionDir(),
    model: options.model,
  });

  return { sessionId: manager.getSessionId(), sessionFile, resumeCommand };
}

// Pi intentionally defers writing a new session until an assistant response
// exists, so a prepared child needs one explicit initial flush of the
// manager-assembled state to be discoverable by `pi --session-id`.
function flushPreparedSession(manager: SessionManager): void {
  const sessionFile = manager.getSessionFile();
  const header = manager.getHeader();
  if (!sessionFile || !header) {
    throw new Error("Prepared handoff session is missing its file or header.");
  }

  const lines = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry));
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, { flag: "wx" });
}

/**
 * The canonical recovery artifact consumed by launch backends, failure
 * messages, clipboard delivery, and renderers. Self-locating: when the target
 * cwd differs from the parent's, the command starts with `cd <target> &&`.
 */
export function buildPiResumeCommand(options: {
  targetCwd: string;
  parentCwd: string;
  sessionId: string;
  sessionDir?: string | undefined;
  model?: string | undefined;
}): string {
  const args = ["pi"];
  if (options.sessionDir) {
    args.push("--session-dir", shellQuote(options.sessionDir));
  }
  args.push("--session-id", shellQuote(options.sessionId));
  if (options.model) {
    args.push("--model", shellQuote(options.model));
  }

  const command = args.join(" ");
  return options.targetCwd === options.parentCwd
    ? command
    : `cd ${shellQuote(options.targetCwd)} && ${command}`;
}
