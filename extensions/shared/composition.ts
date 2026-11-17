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
  /**
   * Runs once every extension's session_start handler has resolved, so the tools and system
   * prompt other extensions set up at startup are in place. Turns started here see them.
   * The root does not await it: startup finishes while it runs.
   */
  onSessionReady?(ctx: ExtensionContext): Promise<void> | void;
  onSessionShutdown?(event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void> | void;
}

/** The index substrate handle passed to features that read the session index. */
export interface IndexHandle {
  path: string;
}
