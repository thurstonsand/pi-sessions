import { join } from "node:path";

function sanitizePipeSegment(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "default"
  );
}

export function getSessionMessagingSocketPath(
  messagingDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-sessions-messaging-${sanitizePipeSegment(messagingDir)}`;
  }

  return join(messagingDir, "broker.sock");
}
