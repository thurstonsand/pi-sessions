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
import type {
  AutoTitleFailure,
  AutoTitleTriggerPlan,
  SessionAutoTitleController,
} from "./controller.js";
import {
  AUTO_TITLE_SYSTEM_PROMPT,
  buildAutoTitlePrompt,
  normalizeGeneratedAutoTitle,
} from "./prompt.js";
import {
  AUTO_TITLE_STATE_CUSTOM_TYPE,
  type AutoTitlePersistedState,
  type AutoTitleTrigger,
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
      result[didRetitle.ok ? "retitled" : "failed"] += 1;
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

export type RetitlePlanResult =
  | {
      ok: true;
      title: string;
    }
  | {
      ok: false;
      failure: AutoTitleFailure;
    };

export async function runRetitlePlan(options: RetitlePlanOptions): Promise<RetitlePlanResult> {
  const { pi, controller, ctx, model, isManual, existingPlan, getSessionEpoch } = options;
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
  const generatedTitle = await generateAutoTitle(ctx, plan, model);
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

async function generateAutoTitle(
  ctx: ExtensionContext,
  plan: AutoTitleTriggerPlan,
  model: Model<Api>,
): Promise<RetitlePlanResult> {
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
): Promise<RetitlePlanResult> {
  if (!titleContext.conversationText) {
    return {
      ok: false,
      failure: createAutoTitleFailure(
        plan.reason,
        model,
        "No conversation available for auto-title generation.",
      ),
    };
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return {
      ok: false,
      failure: createAutoTitleFailure(
        plan.reason,
        model,
        "Failed to authenticate auto-title model.",
      ),
    };
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
      const fallbackMessage =
        response.stopReason === "aborted" ? "Request was aborted." : "Provider returned an error.";
      const failureDetails = extractFailureDetails(
        response.errorMessage || fallbackMessage,
        response,
      );
      return {
        ok: false,
        failure: createAutoTitleFailure(
          plan.reason,
          model,
          failureDetails.message,
          failureDetails.status,
        ),
      };
    }

    const responseText = response.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const normalizedTitle = normalizeGeneratedAutoTitle(responseText);
    if (!normalizedTitle) {
      return {
        ok: false,
        failure: createAutoTitleFailure(plan.reason, model, "Model returned an empty title."),
      };
    }

    return {
      ok: true,
      title: normalizedTitle,
    };
  } catch (error) {
    const failureDetails = extractFailureDetails(error);
    return {
      ok: false,
      failure: createAutoTitleFailure(
        plan.reason,
        model,
        failureDetails.message,
        failureDetails.status,
      ),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function createAutoTitleFailure(
  trigger: AutoTitleTrigger,
  model: Model<Api> | undefined,
  message: string,
  status?: number,
): AutoTitleFailure {
  return {
    at: new Date().toISOString(),
    trigger,
    model: formatModelLabel(model),
    message,
    ...(status !== undefined ? { status } : {}),
  };
}

function formatModelLabel(model: Model<Api> | undefined): string {
  if (!model) {
    return "(no model resolved)";
  }

  return `${model.provider}/${model.id}`;
}

function extractFailureDetails(
  primary: unknown,
  secondary?: unknown,
): { message: string; status?: number } {
  const structured =
    parseStructuredProviderError(primary) ??
    parseStructuredProviderError(secondary) ??
    parseEmbeddedErrorFromObject(primary);
  if (structured) {
    return structured;
  }

  const message =
    extractStringMessage(primary) || extractStringMessage(secondary) || "Unknown provider error.";
  const status = extractStatus(primary) ?? extractStatus(secondary);
  return {
    message,
    ...(status !== undefined ? { status } : {}),
  };
}

function parseEmbeddedErrorFromObject(
  value: unknown,
): { message: string; status?: number } | undefined {
  if (!isObject(value) && !(value instanceof Error)) {
    return undefined;
  }

  const embedded = extractStringMessage(value);
  return embedded ? parseStructuredProviderError(embedded) : undefined;
}

function parseStructuredProviderError(
  value: unknown,
): { message: string; status?: number } | undefined {
  const json = parseJsonObjectCandidate(value);
  if (!json) {
    return undefined;
  }

  const topError = isObject(json.error) ? json.error : undefined;
  const status =
    readNumericStatus(json) ??
    readNumericStatus(topError) ??
    (typeof topError?.code === "number" ? topError.code : undefined);
  const rawMessage =
    readString(topError?.message) ?? readString(json.message) ?? readString(json.errorMessage);
  if (!rawMessage) {
    return undefined;
  }

  const labels = collectProviderErrorLabels(json, topError);
  return {
    message: formatStructuredErrorMessage(labels, rawMessage),
    ...(status !== undefined ? { status } : {}),
  };
}

function collectProviderErrorLabels(
  root: Record<string, unknown>,
  nestedError: Record<string, unknown> | undefined,
): string[] {
  const labels: string[] = [];
  const candidates = [
    readString(nestedError?.status),
    readString(nestedError?.type),
    readString(nestedError?.code),
    readString(root.status),
    readString(root.type),
    readString(root.code),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const normalized = candidate.trim();
    if (!normalized || normalized === "error") {
      continue;
    }

    if (!labels.includes(normalized)) {
      labels.push(normalized);
    }
  }

  return labels;
}

function formatStructuredErrorMessage(labels: string[], rawMessage: string): string {
  const cleanedMessage = stripRedundantErrorPrefix(rawMessage);
  return labels.length > 0 ? `${labels.join(" · ")} · ${cleanedMessage}` : cleanedMessage;
}

function stripRedundantErrorPrefix(message: string): string {
  return message
    .replace(/^Unauthorized:\s*/i, "")
    .replace(/^Authentication (?:error|failed):\s*/i, "")
    .trim();
}

function parseJsonObjectCandidate(value: unknown): Record<string, unknown> | undefined {
  if (isObject(value)) {
    return value;
  }

  const text = extractStringMessage(value);
  if (!text) {
    return undefined;
  }

  const startIndex = text.indexOf("{");
  const endIndex = text.lastIndexOf("}");
  if (startIndex < 0 || endIndex <= startIndex) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text.slice(startIndex, endIndex + 1));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractStringMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (value instanceof Error && value.message.trim()) {
    return value.message.trim();
  }

  if (!isObject(value)) {
    return undefined;
  }

  const directMessage = readString(value.message) ?? readString(value.errorMessage);
  if (directMessage) {
    return directMessage;
  }

  return undefined;
}

function extractStatus(error: unknown): number | undefined {
  const candidates = [
    error,
    isObject(error) ? error.error : undefined,
    isObject(error) ? error.response : undefined,
    isObject(error) && isObject(error.error) ? error.error.response : undefined,
    parseJsonObjectCandidate(error),
  ];

  for (const candidate of candidates) {
    const status = readNumericStatus(candidate);
    if (status !== undefined) {
      return status;
    }
  }

  return undefined;
}

function readNumericStatus(value: unknown): number | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const directStatus = value.status;
  if (typeof directStatus === "number") {
    return directStatus;
  }

  const statusCode = value.statusCode;
  if (typeof statusCode === "number") {
    return statusCode;
  }

  const code = value.code;
  if (typeof code === "number") {
    return code;
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
