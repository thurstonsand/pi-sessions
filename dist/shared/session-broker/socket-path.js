import { homedir } from "node:os";
import { join } from "node:path";
function sanitizePipeSegment(value) {
    return (value
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase() || "default");
}
export function getSessionMessagingDir(homeDir = homedir()) {
    return (process.env.PI_SESSIONS_MESSAGING_DIR ??
        join(homeDir, ".pi", "agent", "pi-sessions", "messaging"));
}
export function getSessionMessagingSocketPath(platform = process.platform, homeDir = homedir()) {
    const messagingDir = getSessionMessagingDir(homeDir);
    if (platform === "win32") {
        return `\\\\.\\pipe\\pi-sessions-messaging-${sanitizePipeSegment(messagingDir)}`;
    }
    return join(messagingDir, "broker.sock");
}
