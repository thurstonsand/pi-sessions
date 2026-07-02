import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RetitleMode, RetitleScope } from "./command.ts";
import { buildAutoTitleContext } from "./context.ts";
import type { AutoTitleTriggerPlan, SessionAutoTitleController } from "./controller.ts";
import {
  type AutoTitleGenerationResult,
  createAutoTitleFailure,
  generateAutoTitle,
} from "./generate.ts";
import {
  AUTO_TITLE_STATE_CUSTOM_TYPE,
  type AutoTitlePersistedState,
  createAutoTitleState,
} from "./state.ts";

export interface RetitleScopeScan {
  scope: Exclude<RetitleScope, "this">;
  sessions: SessionInfo[];
  totalCount: number;
  untitledCount: number;
}

export interface BulkRetitleResult {
  attempted: number;
  retitled: number;
  unchanged: number;
  failed: number;
}

export async function buildRetitleScopeScan(
  ctx: ExtensionCommandContext,
  scope: Exclude<RetitleScope, "this">,
): Promise<RetitleScopeScan> {
  const sessions =
    scope === "folder" ? await SessionManager.list(ctx.cwd) : await SessionManager.listAll();

  return {
    scope,
    sessions,
    totalCount: sessions.length,
    untitledCount: sessions.filter((s) => !hasSessionTitle(s.name)).length,
  };
}

export async function runBulkRetitle(
  pi: ExtensionAPI,
  controller: SessionAutoTitleController,
  ctx: ExtensionCommandContext,
  model: Model<Api> | undefined,
  scan: RetitleScopeScan,
  mode: RetitleMode,
  getSessionEpoch: () => number,
  systemPrompt: string,
): Promise<BulkRetitleResult> {
  const result: BulkRetitleResult = {
    attempted: 0,
    retitled: 0,
    unchanged: 0,
    failed: 0,
  };

  if (!model) {
    result.failed = getEligibleSessions(scan.sessions, mode).length;
    return result;
  }

  const currentSessionFile = ctx.sessionManager.getSessionFile();
  const eligibleSessions = getEligibleSessions(scan.sessions, mode);

  for (const session of eligibleSessions) {
    result.attempted += 1;

    if (currentSessionFile && session.path === currentSessionFile) {
      const didRetitle = await runRetitlePlan({
        pi,
        controller,
        ctx,
        model,
        isManual: true,
        systemPrompt,
        getSessionEpoch,
        notifyOnSuccess: false,
      });
      result[didRetitle.ok ? "retitled" : "failed"] += 1;
      continue;
    }

    const outcome = await retitleStoredSession(ctx, model, session.path, systemPrompt);
    result[outcome] += 1;
  }

  return result;
}

export function notifyBulkRetitleResult(
  ctx: ExtensionCommandContext,
  scan: RetitleScopeScan,
  mode: RetitleMode,
  result: BulkRetitleResult,
): void {
  if (result.attempted === 0) {
    const message =
      mode === "backfill"
        ? `No untitled sessions found ${formatScopeLocation(scan.scope)}.`
        : `No sessions found ${formatScopeLocation(scan.scope)}.`;
    ctx.ui.notify(message, "info");
    return;
  }

  const parts = [
    `Retitled ${result.retitled}/${result.attempted} sessions ${formatScopeLocation(scan.scope)}`,
  ];
  if (result.unchanged > 0) {
    parts.push(`${result.unchanged} unchanged`);
  }
  if (result.failed > 0) {
    parts.push(`${result.failed} failed`);
  }

  ctx.ui.notify(parts.join(" · "), result.failed > 0 ? "warning" : "info");
}

export function getEligibleSessions(sessions: SessionInfo[], mode: RetitleMode): SessionInfo[] {
  if (mode === "all") {
    return sessions;
  }

  return sessions.filter((session) => !hasSessionTitle(session.name));
}

export function buildScopeScanMessage(scope: Exclude<RetitleScope, "this">): string {
  return scope === "folder" ? "Scanning sessions in this folder..." : "Scanning all Pi sessions...";
}

export function buildBulkRetitleMessage(
  scope: Exclude<RetitleScope, "this">,
  mode: RetitleMode,
): string {
  if (scope === "folder") {
    return mode === "all"
      ? "Retitling all sessions in this folder..."
      : "Backfilling untitled sessions in this folder...";
  }

  return mode === "all"
    ? "Retitling all sessions across Pi..."
    : "Backfilling untitled sessions across Pi...";
}

export function formatScopeLocation(scope: Exclude<RetitleScope, "this">): string {
  return scope === "folder" ? "in this folder" : "across all of Pi";
}

export interface RetitlePlanOptions {
  pi: ExtensionAPI;
  controller: SessionAutoTitleController;
  ctx: ExtensionContext;
  model: Model<Api> | undefined;
  isManual: boolean;
  systemPrompt: string;
  existingPlan?: AutoTitleTriggerPlan;
  getSessionEpoch?: () => number;
  notifyOnSuccess?: boolean;
}

export async function runRetitlePlan(
  options: RetitlePlanOptions,
): Promise<AutoTitleGenerationResult> {
  const { pi, controller, ctx, model, isManual, systemPrompt, existingPlan, getSessionEpoch } =
    options;
  const notifyOnSuccess = options.notifyOnSuccess ?? isManual;

  const plan = existingPlan ?? controller.handleManualRetitle(ctx);
  if (!plan) {
    return {
      ok: false,
      failure: createAutoTitleFailure("manual", model, "No retitle plan available."),
    };
  }

  if (!model) {
    return {
      ok: false,
      failure: createAutoTitleFailure(
        plan.reason,
        model,
        "No model available for auto-title generation.",
      ),
    };
  }

  const currentEpoch = getSessionEpoch?.();
  const titleContext = buildAutoTitleContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
    {
      cwd: ctx.cwd,
      currentTitle: plan.currentTitle,
    },
  );
  const generatedTitle = await generateAutoTitle(
    ctx,
    model,
    titleContext,
    plan.reason,
    systemPrompt,
  );
  if (!generatedTitle.ok) {
    return generatedTitle;
  }

  if (currentEpoch !== undefined && currentEpoch !== getSessionEpoch?.()) {
    return {
      ok: false,
      failure: createAutoTitleFailure(
        plan.reason,
        model,
        "Session changed while generating a title.",
      ),
    };
  }

  if (ctx.sessionManager.getSessionName() !== generatedTitle.title) {
    pi.setSessionName(generatedTitle.title);
  }

  const persistedState = controller.handleTitleApplied(generatedTitle.title, plan);
  persistAutoTitleState(pi, persistedState);

  if (notifyOnSuccess && isManual && ctx.hasUI) {
    ctx.ui.notify(`Retitled session: ${generatedTitle.title}`, "info");
  }

  return generatedTitle;
}

export function persistAutoTitleState(
  pi: ExtensionAPI,
  state: AutoTitlePersistedState | undefined,
): void {
  if (!state) {
    return;
  }

  pi.appendEntry(AUTO_TITLE_STATE_CUSTOM_TYPE, state);
}

async function retitleStoredSession(
  ctx: ExtensionContext,
  model: Model<Api>,
  sessionPath: string,
  systemPrompt: string,
): Promise<"retitled" | "unchanged" | "failed"> {
  const sessionManager = SessionManager.open(sessionPath);
  const currentTitle = sessionManager.getSessionName();
  const titleContext = buildAutoTitleContext(
    sessionManager.getEntries(),
    sessionManager.getLeafId(),
    {
      cwd: sessionManager.getCwd(),
      currentTitle,
    },
  );
  const plan: AutoTitleTriggerPlan = {
    reason: "manual",
    userTurnCount: titleContext.userTurnCount,
    currentTitle,
  };
  const generatedTitle = await generateAutoTitle(
    ctx,
    model,
    titleContext,
    plan.reason,
    systemPrompt,
  );
  if (!generatedTitle.ok) {
    return "failed";
  }

  if (currentTitle !== generatedTitle.title) {
    sessionManager.appendSessionInfo(generatedTitle.title);
  }
  sessionManager.appendCustomEntry(
    AUTO_TITLE_STATE_CUSTOM_TYPE,
    createAutoTitleState({
      mode: "active",
      lastAutoTitle: generatedTitle.title,
      lastAppliedUserTurnCount: plan.userTurnCount,
      lastTrigger: plan.reason,
    }),
  );

  return currentTitle === generatedTitle.title ? "unchanged" : "retitled";
}

function hasSessionTitle(name: string | undefined): boolean {
  return Boolean(name?.trim());
}
