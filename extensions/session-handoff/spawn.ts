import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  type SessionHeader,
  type SessionInfoEntry,
} from "@earendil-works/pi-coding-agent";
import { shellQuote } from "./launch/shell.ts";
import {
  encodeHandoffBootstrap,
  HANDOFF_BOOTSTRAP_ENV,
  type HandoffBootstrap,
} from "./metadata.ts";

export interface CreatedHandoffSession {
  sessionId: string;
  sessionFile: string;
}

export interface PreparedHandoff {
  sessionId: string;
  resumeCommand: string;
}

/**
 * Owns the backend-independent half of a handoff: create the session file, encode
 * the bootstrap, and build the resume command every failure path must surface.
 */
export function prepareHandoffLaunch(options: {
  cwd: string;
  sessionDir: string;
  parentSessionFile: string;
  title: string;
  model: string | undefined;
  buildBootstrap: (sessionId: string) => HandoffBootstrap;
}): PreparedHandoff {
  const created = createHandoffSession({
    cwd: options.cwd,
    sessionDir: options.sessionDir,
    parentSessionFile: options.parentSessionFile,
    title: options.title,
  });
  const bootstrapValue = encodeHandoffBootstrap(options.buildBootstrap(created.sessionId));
  const resumeCommand = buildPiResumeCommand(
    options.sessionDir,
    created.sessionId,
    bootstrapValue,
    options.title,
    options.model,
  );
  return { sessionId: created.sessionId, resumeCommand };
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
