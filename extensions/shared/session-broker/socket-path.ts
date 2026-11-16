import { homedir } from "node:os";
import { join } from "node:path";

// Mirrors pi's getAgentDir() because the compiled broker must run with no dependencies installed.
function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function sanitizePipeSegment(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "default"
  );
}

export function getSessionMessagingDir(): string {
  return process.env.PI_SESSIONS_MESSAGING_DIR ?? join(getAgentDir(), "pi-sessions", "messaging");
}

export function getSessionMessagingSocketPath(
  platform: NodeJS.Platform = process.platform,
): string {
  const messagingDir = getSessionMessagingDir();
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-sessions-messaging-${sanitizePipeSegment(messagingDir)}`;
  }

  return join(messagingDir, "broker.sock");
}
