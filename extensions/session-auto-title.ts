import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createSessionAutoTitleCommandHandler,
  getRetitleArgumentCompletions,
  type RetitleCommandInvocation,
  type RetitleCommandOutcome,
} from "./session-auto-title/command.ts";
import {
  createSessionAutoTitleController,
  type SessionAutoTitleController,
} from "./session-auto-title/controller.ts";
import type { AutoTitleGeneration } from "./session-auto-title/generate.ts";
import {
  type AutoTitleModelResolution,
  resolveAutoTitleModel,
} from "./session-auto-title/model.ts";
import {
  buildRetitleScopeScan,
  notifyBulkRetitleResult,
  persistAutoTitleState,
  runBulkRetitle,
  runRetitlePlan,
} from "./session-auto-title/retitle.ts";
import { showRetitleWizard } from "./session-auto-title/wizard.ts";
import { isTuiMode } from "./shared/pi-mode.ts";
import { loadSettings } from "./shared/settings.ts";

export {
  createSessionAutoTitleCommandHandler,
  getRetitleArgumentCompletions,
  parseRetitleCommand,
  TITLE_USAGE,
} from "./session-auto-title/command.ts";

interface TitleRunState {
  controller: SessionAutoTitleController;
  getSessionEpoch: () => number;
  setInFlight: (work: Promise<void>) => void;
  clearInFlight: () => void;
}

export default function sessionAutoTitleExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();
  const controller = createSessionAutoTitleController(settings.autoTitle);
  let sessionEpoch = 0;
  let titleWorkInFlight: Promise<void> | undefined;
  let resolution: AutoTitleModelResolution | undefined;

  // An explicit thinkingLevel setting overrides a thinking suffix on the configured model.
  const buildGeneration = (): AutoTitleGeneration => ({
    systemPrompt: settings.autoTitle.prompt,
    timeoutMs: settings.autoTitle.timeoutMs,
    thinkingLevel: settings.autoTitle.thinkingLevel ?? resolution?.thinkingLevel,
  });

  pi.registerCommand("title", {
    description: "Generate titles for this session, this folder, or all of Pi",
    getArgumentCompletions: getRetitleArgumentCompletions,
    handler: createSessionAutoTitleCommandHandler(
      async (invocation, ctx): Promise<RetitleCommandOutcome> => {
        if (titleWorkInFlight) {
          await titleWorkInFlight;
        }

        resolution ??= resolveAutoTitleModel(ctx, settings.autoTitle.model);
        return handleTitleInvocation(
          pi,
          {
            controller,
            getSessionEpoch: () => sessionEpoch,
            setInFlight: (work) => {
              titleWorkInFlight = work;
            },
            clearInFlight: () => {
              titleWorkInFlight = undefined;
            },
          },
          ctx,
          resolution?.model,
          invocation,
          buildGeneration(),
        );
      },
    ),
  });

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    sessionEpoch += 1;
    resolution = resolveAutoTitleModel(ctx, settings.autoTitle.model);
    persistAutoTitleState(pi, controller.handleSessionStart(ctx));
  });

  pi.on("turn_end", async (_event: TurnEndEvent, ctx: ExtensionContext) => {
    const result = controller.handleTurnEnd(ctx);
    persistAutoTitleState(pi, result.persistedState);

    if (!result.plan || titleWorkInFlight) {
      return;
    }

    titleWorkInFlight = runRetitlePlan({
      pi,
      controller,
      ctx,
      model: resolution?.model,
      isManual: false,
      existingPlan: result.plan,
      getSessionEpoch: () => sessionEpoch,
      notifyOnSuccess: false,
      generation: buildGeneration(),
    })
      .then((outcome) => {
        if (outcome.ok) {
          return;
        }

        const shouldNotify = controller.handleTitleFailed(ctx, outcome.failure);
        if (shouldNotify && ctx.hasUI) {
          ctx.ui.notify(
            `Auto-title failed: ${outcome.failure.message}. Open /title for details.`,
            "warning",
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        titleWorkInFlight = undefined;
      });
  });

  pi.on("session_shutdown", async () => {
    sessionEpoch += 1;
    controller.handleSessionShutdown();
    titleWorkInFlight = undefined;
    resolution = undefined;
  });
}

async function handleTitleInvocation(
  pi: ExtensionAPI,
  state: TitleRunState,
  ctx: ExtensionCommandContext,
  model: Model<Api> | undefined,
  invocation: RetitleCommandInvocation,
  generation: AutoTitleGeneration,
): Promise<RetitleCommandOutcome> {
  const retitleOpts = {
    pi,
    controller: state.controller,
    ctx,
    model,
    isManual: true,
    generation,
    getSessionEpoch: state.getSessionEpoch,
  };

  const retitleCurrentSession = async (): Promise<RetitleCommandOutcome> => {
    const result = await runRetitlePlan(retitleOpts);
    if (result.ok) {
      return "success";
    }

    state.controller.handleTitleFailed(ctx, result.failure);
    return "failed";
  };

  if (invocation.kind === "open-pane") {
    if (!isTuiMode(ctx)) {
      return retitleCurrentSession();
    }

    return showRetitleWizard(pi, state.controller, ctx, model, state.getSessionEpoch, generation);
  }

  if (invocation.scope === "this") {
    return runWithInFlightTracking(state, retitleCurrentSession);
  }

  if (isTuiMode(ctx) && !invocation.force) {
    return showRetitleWizard(pi, state.controller, ctx, model, state.getSessionEpoch, generation, {
      initialInvocation: {
        scope: invocation.scope,
        mode: invocation.mode ?? "backfill",
      },
    });
  }

  const scan = await buildRetitleScopeScan(ctx, invocation.scope);
  const mode = invocation.mode ?? "backfill";
  return runWithInFlightTracking(state, async () => {
    const result = await runBulkRetitle(
      pi,
      state.controller,
      ctx,
      model,
      scan,
      mode,
      state.getSessionEpoch,
      generation,
    );
    notifyBulkRetitleResult(ctx, scan, mode, result);
    return "success";
  });
}

async function runWithInFlightTracking(
  state: TitleRunState,
  work: () => Promise<RetitleCommandOutcome>,
): Promise<RetitleCommandOutcome> {
  const outcomePromise = work().catch(() => "failed" as const);
  state.setInFlight(outcomePromise.then(() => {}));

  try {
    return await outcomePromise;
  } finally {
    state.clearInFlight();
  }
}
