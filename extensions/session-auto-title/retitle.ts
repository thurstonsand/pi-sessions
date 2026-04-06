import {
  type Api,
  completeSimple,
  type Model,
  type TextContent,
  type UserMessage,
} from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionInfo,
} from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { RetitleMode, RetitleScope } from "./command.js";
import { type AutoTitleContext, buildAutoTitleContext } from "./context.js";
import type { AutoTitleTriggerPlan, SessionAutoTitleController } from "./controller.js";
import {
  AUTO_TITLE_SYSTEM_PROMPT,
  buildAutoTitlePrompt,
  normalizeGeneratedAutoTitle,
} from "./prompt.js";
import {
  AUTO_TITLE_STATE_CUSTOM_TYPE,
  type AutoTitlePersistedState,
  createAutoTitleState,
} from "./state.js";

const AUTO_TITLE_REQUEST_TIMEOUT_MS = 15_000;
const AUTO_TITLE_MAX_TOKENS = 64;

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
        getSessionEpoch,
        notifyOnSuccess: false,
      });
      result[didRetitle ? "retitled" : "failed"] += 1;
      continue;
    }

    const outcome = await retitleStoredSession(ctx, model, session.path);
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
  existingPlan?: AutoTitleTriggerPlan;
  getSessionEpoch?: () => number;
  notifyOnSuccess?: boolean;
}

export async function runRetitlePlan(options: RetitlePlanOptions): Promise<boolean> {
  const { pi, controller, ctx, model, isManual, existingPlan, getSessionEpoch } = options;
  const notifyOnSuccess = options.notifyOnSuccess ?? isManual;

  const plan = existingPlan ?? controller.handleManualRetitle(ctx);
  if (!plan || !model) {
    return false;
  }

  const currentEpoch = getSessionEpoch?.();
  const generatedTitle = await generateAutoTitle(ctx, plan, model);
  if (!generatedTitle) {
    return false;
  }

  if (currentEpoch !== undefined && currentEpoch !== getSessionEpoch?.()) {
    return false;
  }

  if (ctx.sessionManager.getSessionName() !== generatedTitle) {
    pi.setSessionName(generatedTitle);
  }

  const persistedState = controller.handleTitleApplied(generatedTitle, plan);
  persistAutoTitleState(pi, persistedState);

  if (notifyOnSuccess && isManual && ctx.hasUI) {
    ctx.ui.notify(`Retitled session: ${generatedTitle}`, "info");
  }

  return true;
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
  const generatedTitle = await generateAutoTitleFromContext(ctx, plan, model, titleContext);
  if (!generatedTitle) {
    return "failed";
  }

  if (currentTitle !== generatedTitle) {
    sessionManager.appendSessionInfo(generatedTitle);
  }
  sessionManager.appendCustomEntry(
    AUTO_TITLE_STATE_CUSTOM_TYPE,
    createAutoTitleState({
      mode: "active",
      lastAutoTitle: generatedTitle,
      lastAppliedUserTurnCount: plan.userTurnCount,
      lastTrigger: plan.reason,
    }),
  );

  return currentTitle === generatedTitle ? "unchanged" : "retitled";
}

function hasSessionTitle(name: string | undefined): boolean {
  return Boolean(name?.trim());
}

async function generateAutoTitle(
  ctx: ExtensionContext,
  plan: AutoTitleTriggerPlan,
  model: Model<Api>,
): Promise<string | undefined> {
  const titleContext = buildAutoTitleContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
    {
      cwd: ctx.cwd,
      currentTitle: plan.currentTitle,
    },
  );
  return generateAutoTitleFromContext(ctx, plan, model, titleContext);
}

async function generateAutoTitleFromContext(
  ctx: ExtensionContext,
  plan: AutoTitleTriggerPlan,
  model: Model<Api>,
  titleContext: AutoTitleContext,
): Promise<string | undefined> {
  if (!titleContext.conversationText) {
    return undefined;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return undefined;
  }

  const message: UserMessage = {
    role: "user",
    content: [{ type: "text", text: buildAutoTitlePrompt(titleContext, plan.reason) }],
    timestamp: Date.now(),
  };

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), AUTO_TITLE_REQUEST_TIMEOUT_MS);

  try {
    const response = await completeSimple(
      model,
      {
        systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
        messages: [message],
      },
      {
        ...(auth.apiKey && { apiKey: auth.apiKey }),
        ...(auth.headers && { headers: auth.headers }),
        maxTokens: AUTO_TITLE_MAX_TOKENS,
        signal: abortController.signal,
      },
    );

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return undefined;
    }

    const responseText = response.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("\n");

    return normalizeGeneratedAutoTitle(responseText);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeoutId);
  }
}
