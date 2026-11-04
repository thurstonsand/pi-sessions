import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSessionById, withSessionIndex } from "../shared/session-index/index.ts";
import type { SubagentsHandle } from "../subagents/install.ts";
import { listSubagentSessions, listUserSessions, type SessionListDeps } from "./directory-list.ts";
import type { MessagingHandle } from "./install.ts";
import type { MessageRouter } from "./message-router.ts";
import type { ListedSession, SessionListScope } from "./pi/list-contract.ts";
import type { CancelSessionResult, SendMessageRequest, SendMessageResult } from "./pi/service.ts";
import type { ManagedCancelSessionResult } from "./pi/tools.ts";

/** The addressable set, not a transport. Resolution is enforced before every mutation. */
export interface SessionDirectory {
  list(scope: SessionListScope, ctx: ExtensionContext): Promise<ListedSession[]>;
  resolve(sessionId: string, ctx: ExtensionContext): Promise<{ sessionId: string }>;
  send(request: SendMessageRequest, ctx: ExtensionContext): Promise<SendMessageResult>;
  cancel(
    sessionId: string,
    ctx: ExtensionContext,
  ): Promise<CancelSessionResult | ManagedCancelSessionResult>;
  wake(sessionId: string): Promise<void>;
  getRelationTo(sessionId: string | undefined): string | undefined;
  getParentSessionId(): string | undefined;
}

export function createPeerDirectory(
  messaging: MessagingHandle,
  deps: SessionListDeps,
): SessionDirectory {
  const directory: SessionDirectory = {
    list: (scope, ctx) => {
      if (scope !== "user") throw new Error("Peer discovery has no subagent scope.");
      return listUserSessions(deps, ctx);
    },
    async resolve(sessionId, ctx) {
      const listed = (await directory.list("user", ctx)).some(
        (entry) => entry.session_id === sessionId,
      );
      if (!listed) throw new Error(`No user session ${sessionId}; session_list lists them.`);
      return { sessionId };
    },
    async send(request, ctx) {
      await directory.resolve(request.target, ctx);
      return messaging.sendMessage(request);
    },
    async cancel(sessionId, ctx) {
      await directory.resolve(sessionId, ctx);
      return messaging.cancelSession(sessionId);
    },
    async wake() {
      throw new Error("Peer sessions must already be live.");
    },
    getRelationTo: messaging.getCachedRelationTo,
    getParentSessionId: () => deps.getParentSessionId?.(),
  };
  return directory;
}

export function createSubagentDirectory(
  subagents: SubagentsHandle,
  router: MessageRouter,
  messaging: MessagingHandle,
  indexPath: string,
): SessionDirectory {
  const deps: SessionListDeps = {
    indexPath,
    listSessions: () => messaging.listSessions(),
    getRelationTo: messaging.getCachedRelationTo,
    listSubagents: async (scope) => (await subagents.roster.resolve(scope)).entries,
  };
  const directory: SessionDirectory = {
    list: (scope) => {
      if (scope === "user") throw new Error("Subagent discovery requires branch or tree scope.");
      return listSubagentSessions(deps, scope);
    },
    async resolve(sessionId, ctx) {
      if (sessionId === subagents.getParentSessionId())
        throw new Error("The parent session is not addressable. Use submit_task_report.");
      if (sessionId === ctx.sessionManager.getSessionId())
        throw new Error("The current session is not a subagent target.");
      const listed = (await directory.list("tree", ctx)).some(
        (entry) => entry.session_id === sessionId,
      );
      if (listed) return { sessionId };
      // Known live workers (including siblings) remain addressable without transferring
      // ownership. Only the caller's own ledger can authorize dormant wake or teardown.
      const live = (await messaging.listSessions()).includes(sessionId);
      const worker =
        live &&
        withSessionIndex(
          indexPath,
          { mode: "read", required: true },
          ({ db }) => getSessionById(db, sessionId)?.sessionOrigin === "subagent",
        );
      if (worker) return { sessionId };
      throw new Error(`No subagent ${sessionId}; subagent_list lists them.`);
    },
    async send(request, ctx) {
      await directory.resolve(request.target, ctx);
      return router.sendMessage(request);
    },
    async cancel(sessionId, ctx) {
      await directory.resolve(sessionId, ctx);
      return subagents.cancelSession(sessionId);
    },
    wake: (sessionId) => subagents.waker.wake(sessionId),
    getRelationTo: messaging.getCachedRelationTo,
    getParentSessionId: () => subagents.getParentSessionId(),
  };
  return directory;
}
