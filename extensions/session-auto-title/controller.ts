import { buildSessionContext, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutoTitleSettings } from "../shared/settings.js";
import {
  type AutoTitleMode,
  type AutoTitlePersistedState,
  type AutoTitleTrigger,
  createAutoTitleState,
  getLatestAutoTitleState,
} from "./state.js";

export interface SessionAutoTitleStateSnapshot {
  currentSessionFile: string | undefined;
  mode: AutoTitleMode;
  lastAutoTitle: string | undefined;
  lastAppliedUserTurnCount: number | undefined;
  lastTrigger: AutoTitleTrigger | undefined;
}

export interface AutoTitleTriggerPlan {
  reason: AutoTitleTrigger;
  userTurnCount: number;
  currentTitle: string | undefined;
}

export interface AutoTitleTurnEndResult {
  plan: AutoTitleTriggerPlan | undefined;
  persistedState: AutoTitlePersistedState | undefined;
}

export interface SessionAutoTitleController {
  getState(): SessionAutoTitleStateSnapshot;
  handleSessionStart(ctx: ExtensionContext): AutoTitlePersistedState | undefined;
  handleSessionShutdown(): void;
  handleTurnEnd(ctx: ExtensionContext): AutoTitleTurnEndResult;
  handleManualRetitle(ctx: ExtensionContext): AutoTitleTriggerPlan | undefined;
  handleTitleApplied(title: string, plan: AutoTitleTriggerPlan): AutoTitlePersistedState;
}

interface ControllerState {
  currentSessionFile: string | undefined;
  persistedState: AutoTitlePersistedState;
  snapshot(): SessionAutoTitleStateSnapshot;
  restore(ctx: ExtensionContext): void;
  clear(): void;
  ensureAttached(ctx: ExtensionContext): void;
}

export function createSessionAutoTitleController(
  settings: AutoTitleSettings,
): SessionAutoTitleController {
  const state = createControllerState();

  return {
    getState() {
      return state.snapshot();
    },
    handleSessionStart(ctx) {
      state.restore(ctx);
      return pauseForManualOverrideIfNeeded(state, ctx);
    },
    handleSessionShutdown() {
      state.clear();
    },
    handleTurnEnd(ctx) {
      state.ensureAttached(ctx);
      const persistedState = pauseForManualOverrideIfNeeded(state, ctx);
      if (state.persistedState.mode === "paused_manual") {
        return { plan: undefined, persistedState };
      }

      const sessionContext = buildSessionContext(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getLeafId(),
      );
      const userTurnCount = countUserTurns(sessionContext.messages);
      const reason = resolveAutoTriggerReason(
        settings.refreshTurns,
        userTurnCount,
        ctx.sessionManager.getSessionName(),
        state.persistedState,
      );
      if (!reason) {
        return { plan: undefined, persistedState };
      }

      return {
        plan: buildTriggerPlan(ctx, reason, userTurnCount),
        persistedState,
      };
    },
    handleManualRetitle(ctx) {
      state.ensureAttached(ctx);
      return buildTriggerPlan(
        ctx,
        "manual",
        countUserTurns(
          buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId())
            .messages,
        ),
      );
    },
    handleTitleApplied(title, plan) {
      state.persistedState = createAutoTitleState({
        mode: "active",
        lastAutoTitle: title,
        lastAppliedUserTurnCount: plan.userTurnCount,
        lastTrigger: plan.reason,
      });
      return state.persistedState;
    },
  };
}

function createControllerState(): ControllerState {
  return {
    currentSessionFile: undefined,
    persistedState: createAutoTitleState(),
    snapshot() {
      return {
        currentSessionFile: this.currentSessionFile,
        mode: this.persistedState.mode,
        lastAutoTitle: this.persistedState.lastAutoTitle,
        lastAppliedUserTurnCount: this.persistedState.lastAppliedUserTurnCount,
        lastTrigger: this.persistedState.lastTrigger,
      };
    },
    restore(ctx) {
      this.currentSessionFile = ctx.sessionManager.getSessionFile();
      this.persistedState =
        getLatestAutoTitleState(ctx.sessionManager.getBranch()) ?? createAutoTitleState();
    },
    clear() {
      this.currentSessionFile = undefined;
      this.persistedState = createAutoTitleState();
    },
    ensureAttached(ctx) {
      if (ctx.sessionManager.getSessionFile() === this.currentSessionFile) {
        return;
      }

      this.restore(ctx);
    },
  };
}

function pauseForManualOverrideIfNeeded(
  state: ControllerState,
  ctx: ExtensionContext,
): AutoTitlePersistedState | undefined {
  if (state.persistedState.mode === "paused_manual") {
    return undefined;
  }

  const currentTitle = ctx.sessionManager.getSessionName();
  const lastAutoTitle = state.persistedState.lastAutoTitle;

  if (lastAutoTitle === undefined) {
    if (!currentTitle) {
      return undefined;
    }
  } else if (currentTitle === lastAutoTitle) {
    return undefined;
  }

  state.persistedState = createAutoTitleState({
    mode: "paused_manual",
    ...(lastAutoTitle ? { lastAutoTitle } : {}),
    ...(state.persistedState.lastAppliedUserTurnCount
      ? { lastAppliedUserTurnCount: state.persistedState.lastAppliedUserTurnCount }
      : {}),
    ...(state.persistedState.lastTrigger ? { lastTrigger: state.persistedState.lastTrigger } : {}),
  });
  return state.persistedState;
}

function resolveAutoTriggerReason(
  refreshTurns: number,
  userTurnCount: number,
  currentTitle: string | undefined,
  persistedState: AutoTitlePersistedState,
): AutoTitleTrigger | undefined {
  if (!currentTitle && !persistedState.lastAutoTitle && userTurnCount === 1) {
    return "initial";
  }

  const lastAppliedUserTurnCount = persistedState.lastAppliedUserTurnCount ?? 0;
  if (userTurnCount - lastAppliedUserTurnCount < refreshTurns) {
    return undefined;
  }

  return "periodic";
}

function buildTriggerPlan(
  ctx: ExtensionContext,
  reason: AutoTitleTrigger,
  userTurnCount: number,
): AutoTitleTriggerPlan {
  return {
    reason,
    userTurnCount,
    currentTitle: ctx.sessionManager.getSessionName(),
  };
}

function countUserTurns(messages: Array<{ role: string }>): number {
  let userTurnCount = 0;

  for (const message of messages) {
    if (message.role === "user") {
      userTurnCount += 1;
    }
  }

  return userTurnCount;
}
