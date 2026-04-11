import { buildSessionContext, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutoTitleSettings } from "../shared/settings.js";
import {
  type AutoTitleMode,
  type AutoTitlePersistedState,
  type AutoTitleTrigger,
  createAutoTitleState,
  getLatestAutoTitleState,
} from "./state.js";

export interface AutoTitleFailure {
  at: string;
  trigger: AutoTitleTrigger;
  model: string;
  message: string;
  status?: number;
}

export function formatAutoTitleFailureSummary(failure: AutoTitleFailure): string {
  return failure.status === undefined
    ? failure.message
    : `HTTP ${failure.status} · ${failure.message}`;
}

export interface SessionAutoTitleStateSnapshot {
  currentSessionFile: string | undefined;
  mode: AutoTitleMode;
  lastAutoTitle: string | undefined;
  lastAppliedUserTurnCount: number | undefined;
  lastTrigger: AutoTitleTrigger | undefined;
  lastFailure: AutoTitleFailure | undefined;
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

export interface AutoRetitleStatus {
  mode: AutoTitleMode;
  userTurnCount: number;
  turnsUntilAutoRetitle: number | undefined;
}

export interface SessionAutoTitleController {
  getState(): SessionAutoTitleStateSnapshot;
  getAutoRetitleStatus(ctx: ExtensionContext): AutoRetitleStatus;
  getLastFailure(ctx: ExtensionContext): AutoTitleFailure | undefined;
  handleSessionStart(ctx: ExtensionContext): AutoTitlePersistedState | undefined;
  handleSessionShutdown(): void;
  handleTurnEnd(ctx: ExtensionContext): AutoTitleTurnEndResult;
  handleManualRetitle(ctx: ExtensionContext): AutoTitleTriggerPlan | undefined;
  handleTitleApplied(title: string, plan: AutoTitleTriggerPlan): AutoTitlePersistedState;
  handleTitleFailed(ctx: ExtensionContext, failure: AutoTitleFailure): boolean;
}

interface ControllerState {
  currentSessionFile: string | undefined;
  persistedState: AutoTitlePersistedState;
  lastFailure: AutoTitleFailure | undefined;
  lastNotifiedFailureKey: string | undefined;
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
    getAutoRetitleStatus(ctx) {
      state.ensureAttached(ctx);
      pauseForManualOverrideIfNeeded(state, ctx);

      const userTurnCount = countUserTurns(
        buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId())
          .messages,
      );
      if (state.persistedState.mode === "paused_manual") {
        return {
          mode: state.persistedState.mode,
          userTurnCount,
          turnsUntilAutoRetitle: undefined,
        };
      }

      const status = resolveAutoRetitleStatus(
        settings.refreshTurns,
        userTurnCount,
        ctx.sessionManager.getSessionName(),
        state.persistedState,
      );
      return {
        mode: state.persistedState.mode,
        userTurnCount,
        turnsUntilAutoRetitle: status.turnsUntilAutoRetitle,
      };
    },
    getLastFailure(ctx) {
      state.ensureAttached(ctx);
      return state.lastFailure;
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
      const status = resolveAutoRetitleStatus(
        settings.refreshTurns,
        userTurnCount,
        ctx.sessionManager.getSessionName(),
        state.persistedState,
      );
      if (!status.reason) {
        return { plan: undefined, persistedState };
      }

      return {
        plan: buildTriggerPlan(ctx, status.reason, userTurnCount),
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
      state.lastFailure = undefined;
      state.lastNotifiedFailureKey = undefined;
      state.persistedState = createAutoTitleState({
        mode: "active",
        lastAutoTitle: title,
        lastAppliedUserTurnCount: plan.userTurnCount,
        lastTrigger: plan.reason,
      });
      return state.persistedState;
    },
    handleTitleFailed(ctx, failure) {
      state.ensureAttached(ctx);
      state.lastFailure = failure;

      const failureKey = formatFailureKey(failure);
      if (failureKey === state.lastNotifiedFailureKey) {
        return false;
      }

      state.lastNotifiedFailureKey = failureKey;
      return true;
    },
  };
}

function createControllerState(): ControllerState {
  return {
    currentSessionFile: undefined,
    persistedState: createAutoTitleState(),
    lastFailure: undefined,
    lastNotifiedFailureKey: undefined,
    snapshot() {
      return {
        currentSessionFile: this.currentSessionFile,
        mode: this.persistedState.mode,
        lastAutoTitle: this.persistedState.lastAutoTitle,
        lastAppliedUserTurnCount: this.persistedState.lastAppliedUserTurnCount,
        lastTrigger: this.persistedState.lastTrigger,
        lastFailure: this.lastFailure,
      };
    },
    restore(ctx) {
      this.currentSessionFile = ctx.sessionManager.getSessionFile();
      this.persistedState =
        getLatestAutoTitleState(ctx.sessionManager.getBranch()) ?? createAutoTitleState();
      this.lastFailure = undefined;
      this.lastNotifiedFailureKey = undefined;
    },
    clear() {
      this.currentSessionFile = undefined;
      this.persistedState = createAutoTitleState();
      this.lastFailure = undefined;
      this.lastNotifiedFailureKey = undefined;
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
  const titleMatchesOrBothEmpty =
    lastAutoTitle === undefined ? !currentTitle : currentTitle === lastAutoTitle;
  if (titleMatchesOrBothEmpty) {
    return undefined;
  }

  state.persistedState = createAutoTitleState({
    mode: "paused_manual",
    ...(lastAutoTitle && { lastAutoTitle }),
    ...(state.persistedState.lastAppliedUserTurnCount && {
      lastAppliedUserTurnCount: state.persistedState.lastAppliedUserTurnCount,
    }),
    ...(state.persistedState.lastTrigger && { lastTrigger: state.persistedState.lastTrigger }),
  });
  return state.persistedState;
}

function resolveAutoRetitleStatus(
  refreshTurns: number,
  userTurnCount: number,
  currentTitle: string | undefined,
  persistedState: AutoTitlePersistedState,
): { reason: AutoTitleTrigger | undefined; turnsUntilAutoRetitle: number } {
  if (!currentTitle && !persistedState.lastAutoTitle && userTurnCount === 1) {
    return {
      reason: "initial",
      turnsUntilAutoRetitle: 0,
    };
  }

  const lastAppliedUserTurnCount = persistedState.lastAppliedUserTurnCount ?? 0;
  const turnsSinceLastRetitle = userTurnCount - lastAppliedUserTurnCount;
  if (turnsSinceLastRetitle < refreshTurns) {
    return {
      reason: undefined,
      turnsUntilAutoRetitle: refreshTurns - turnsSinceLastRetitle,
    };
  }

  return {
    reason: "periodic",
    turnsUntilAutoRetitle: 0,
  };
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
  return messages.filter((message) => message.role === "user").length;
}

function formatFailureKey(failure: AutoTitleFailure): string {
  return `${failure.model}\n${failure.status ?? ""}\n${failure.message}`;
}
