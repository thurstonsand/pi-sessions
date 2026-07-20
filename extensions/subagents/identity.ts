import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findOwnedSubagentLaunch } from "./ledger.ts";

export interface SubagentIdentity {
  childSessionId: string;
  ownerSessionId: string;
  parentSessionFile: string;
  depth: number;
  requestResponse: boolean;
}

interface SubagentSession {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getHeader(): { parentSession?: string | undefined } | null;
}

export function findSubagentIdentity(
  sessionManager: SubagentSession,
): SubagentIdentity | undefined {
  const childSessionId = sessionManager.getSessionId();
  const parentSessionFile = sessionManager.getHeader()?.parentSession?.trim();
  if (!parentSessionFile) {
    return undefined;
  }

  try {
    const parent = SessionManager.open(parentSessionFile);
    const ownerSessionId = parent.getSessionId();
    const launch = findOwnedSubagentLaunch(parent.getEntries(), ownerSessionId, childSessionId);
    if (!launch || launch.childSessionFile !== sessionManager.getSessionFile()) {
      return undefined;
    }

    return {
      childSessionId,
      ownerSessionId,
      parentSessionFile,
      depth: launch.depth,
      requestResponse: launch.requestResponse,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
