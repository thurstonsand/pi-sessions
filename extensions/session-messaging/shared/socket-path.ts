import { homedir } from "node:os";
import { join } from "node:path";

function sanitizePipeSegment(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "default"
  );
}

export function getSessionMessagingDir(homeDir: string = homedir()): string {
  return (
    process.env.PI_SESSIONS_MESSAGING_DIR ??
    join(homeDir, ".pi", "agent", "pi-sessions", "messaging")
  );
}

export function getSessionMessagingSocketPath(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): string {
  const messagingDir = getSessionMessagingDir(homeDir);
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-sessions-messaging-${sanitizePipeSegment(messagingDir)}`;
  }

  return join(messagingDir, "broker.sock");
}
