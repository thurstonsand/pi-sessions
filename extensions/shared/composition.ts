import type {
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

/**
 * Session lifecycle hooks a feature exposes to the composition root. The root owns the
 * single `session_start`/`session_shutdown` subscription and drives these deterministically,
 * so features never subscribe to those two events themselves.
 */
export interface SessionLifecycle {
  onSessionStart?(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> | void;
  onSessionShutdown?(event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void> | void;
}

/** The index substrate handle passed to features that read the session index. */
export interface IndexHandle {
  path: string;
}
