import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RetitleCommandOutcome, RetitleMode, RetitleScope } from "./command.ts";
import type { SessionAutoTitleController } from "./controller.ts";
import type { AutoTitleGeneration } from "./generate.ts";
import {
  buildBulkRetitleMessage,
  buildRetitleScopeScan,
  formatScopeLocation,
  getEligibleSessions,
  notifyBulkRetitleResult,
  runBulkRetitle,
  runRetitlePlan,
  type StoredSessionTitleModel,
} from "./retitle.ts";
import {
  describeAutoRetitleStatus,
  formatFailureClipboardText,
  type RetitleWizardOptions,
} from "./wizard.ts";

/** The retitle wizard's flow as host dialogs, for modes such as RPC that cannot show custom UI. */
export async function showRetitleDialog(
  pi: ExtensionAPI,
  controller: SessionAutoTitleController,
  ctx: ExtensionCommandContext,
  model: Model<Api> | undefined,
  storedTitleModel: StoredSessionTitleModel,
  getSessionEpoch: () => number,
  generation: AutoTitleGeneration,
  options?: RetitleWizardOptions,
): Promise<RetitleCommandOutcome> {
  const scope = options?.initialInvocation?.scope ?? (await selectScope(controller, ctx));
  if (!scope) return "cancelled";

  if (scope === "this") {
    await ctx.waitForIdle();
    const result = await runRetitlePlan({
      pi,
      controller,
      ctx,
      model,
      isManual: true,
      generation,
      getSessionEpoch,
    });
    if (result.ok) return "success";
    controller.handleTitleFailed(ctx, result.failure);
    return "failed";
  }

  const scan = await buildRetitleScopeScan(ctx, scope);
  const location = formatScopeLocation(scope);
  if (scan.totalCount === 0) {
    ctx.ui.notify(`No sessions found ${location}.`, "info");
    return "cancelled";
  }

  const requestedMode = options?.initialInvocation?.mode;
  if (requestedMode && getEligibleSessions(scan.sessions, requestedMode).length === 0) {
    ctx.ui.notify(`No untitled sessions found ${location}.`, "info");
    return "cancelled";
  }

  const backfill = `Generate missing titles (${scan.untitledCount})`;
  const all = `Regenerate all sessions, even ones that already have titles (${scan.totalCount})`;
  const choice = await ctx.ui.select(
    `**Session titles ${location}**\n\n${scan.untitledCount} of ${scan.totalCount} sessions have no title.`,
    [backfill, all],
  );
  const mode: RetitleMode | undefined =
    choice === backfill ? "backfill" : choice === all ? "all" : undefined;
  if (!mode) return "cancelled";

  if (mode === "backfill" && getEligibleSessions(scan.sessions, "backfill").length === 0) {
    ctx.ui.notify(`No untitled sessions found ${location}.`, "info");
    return "cancelled";
  }

  if (
    scope === "global" &&
    mode === "all" &&
    !(await ctx.ui.confirm(
      "Retitle all of Pi?",
      `This will retitle ${scan.totalCount} sessions across all of Pi. This may take some time and may be expensive.`,
    ))
  ) {
    return "cancelled";
  }

  ctx.ui.notify(buildBulkRetitleMessage(scope, mode), "info");
  await ctx.waitForIdle();
  const result = await runBulkRetitle(
    pi,
    controller,
    ctx,
    model,
    storedTitleModel,
    scan,
    mode,
    getSessionEpoch,
    generation,
  );
  notifyBulkRetitleResult(ctx, scan, mode, result);
  return result.failed > 0 && result.retitled === 0 && result.unchanged === 0
    ? "failed"
    : "success";
}

async function selectScope(
  controller: SessionAutoTitleController,
  ctx: ExtensionCommandContext,
): Promise<RetitleScope | undefined> {
  const status = controller.getAutoRetitleStatus(ctx);
  const failure = controller.getLastFailure(ctx);
  const scopes: Array<[RetitleScope, string]> = [
    [
      "this",
      status.mode === "paused_manual"
        ? "Regenerate title for this session (restarts auto-updates)"
        : "Regenerate title for this session",
    ],
    ["folder", "Generate titles for all sessions in this folder"],
    ["global", "Generate titles for all sessions of Pi"],
  ];
  const title = [
    "**Session titles**",
    "",
    `This session: ${ctx.sessionManager.getSessionName()?.trim() || "(untitled)"} ${describeAutoRetitleStatus(status)}`,
    ...(failure
      ? ["", "Last auto-title error:", "```", formatFailureClipboardText(failure), "```"]
      : []),
  ].join("\n");
  const choice = await ctx.ui.select(
    title,
    scopes.map(([, label]) => label),
  );
  return scopes.find(([, label]) => label === choice)?.[0];
}
