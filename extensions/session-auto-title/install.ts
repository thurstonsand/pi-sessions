import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ModelRuntime,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { SessionLifecycle } from "../shared/composition.ts";
import type { ModelRuntimeProvider } from "../shared/model-runtime.ts";
import { isTuiMode } from "../shared/pi-mode.ts";
import type { SessionSettings } from "../shared/settings.ts";
import {
  createSessionAutoTitleCommandHandler,
  getRetitleArgumentCompletions,
  type RetitleCommandInvocation,
  type RetitleCommandOutcome,
} from "./command.ts";
import { createSessionAutoTitleController, type SessionAutoTitleController } from "./controller.ts";
import type { AutoTitleGeneration } from "./generate.ts";
import { type AutoTitleModelResolution, resolveAutoTitleModel } from "./model.ts";
import {
  buildRetitleScopeScan,
  notifyBulkRetitleResult,
  persistAutoTitleState,
  runBulkRetitle,
  runRetitlePlan,
} from "./retitle.ts";
import { showRetitleWizard } from "./wizard.ts";

interface TitleRunState {
  controller: SessionAutoTitleController;
  getSessionEpoch: () => number;
  setInFlight: (work: Promise<void>) => void;
  clearInFlight: () => void;
}

export function installAutoTitle(
  pi: ExtensionAPI,
  deps: {
    settings: SessionSettings;
    getModelRuntime: ModelRuntimeProvider;
    getSessionEpoch: () => number;
  },
): SessionLifecycle {
  const { settings, getModelRuntime, getSessionEpoch } = deps;
  const controller = createSessionAutoTitleController(settings.autoTitle);
  let titleWorkInFlight: Promise<void> | undefined;

  // An explicit thinkingLevel setting overrides a thinking suffix on the configured model.
  const buildGeneration = (
    resolution: AutoTitleModelResolution | undefined,
  ): AutoTitleGeneration => ({
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

        const modelRuntime = await getModelRuntime(ctx.modelRegistry);
        const resolution = resolveAutoTitleModel(modelRuntime, ctx.model, settings.autoTitle.model);
        return handleTitleInvocation(
          pi,
          {
            controller,
            getSessionEpoch,
            setInFlight: (work) => {
              titleWorkInFlight = work;
            },
            clearInFlight: () => {
              titleWorkInFlight = undefined;
            },
          },
          ctx,
          modelRuntime,
          resolution?.model,
          invocation,
          buildGeneration(resolution),
        );
      },
    ),
  });

  pi.on("turn_end", async (_event: TurnEndEvent, ctx: ExtensionContext) => {
    const result = controller.handleTurnEnd(ctx);
    persistAutoTitleState(pi, result.persistedState);

    if (!result.plan || titleWorkInFlight) {
      return;
    }

    const modelRuntime = await getModelRuntime(ctx.modelRegistry);
    const resolution = resolveAutoTitleModel(modelRuntime, ctx.model, settings.autoTitle.model);
    titleWorkInFlight = runRetitlePlan({
      pi,
      controller,
      ctx,
      modelRuntime,
      model: resolution?.model,
      isManual: false,
      existingPlan: result.plan,
      getSessionEpoch,
      notifyOnSuccess: false,
      generation: buildGeneration(resolution),
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

  return {
    onSessionStart(_event, ctx) {
      persistAutoTitleState(pi, controller.handleSessionStart(ctx));
    },
    onSessionShutdown() {
      controller.handleSessionShutdown();
      titleWorkInFlight = undefined;
    },
  };
}

async function handleTitleInvocation(
  pi: ExtensionAPI,
  state: TitleRunState,
  ctx: ExtensionCommandContext,
  modelRuntime: ModelRuntime,
  model: Model<Api> | undefined,
  invocation: RetitleCommandInvocation,
  generation: AutoTitleGeneration,
): Promise<RetitleCommandOutcome> {
  const retitleOpts = {
    pi,
    controller: state.controller,
    ctx,
    modelRuntime,
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

    return showRetitleWizard(
      pi,
      state.controller,
      ctx,
      modelRuntime,
      model,
      state.getSessionEpoch,
      generation,
    );
  }

  if (invocation.scope === "this") {
    return runWithInFlightTracking(state, retitleCurrentSession);
  }

  if (isTuiMode(ctx) && !invocation.force) {
    return showRetitleWizard(
      pi,
      state.controller,
      ctx,
      modelRuntime,
      model,
      state.getSessionEpoch,
      generation,
      {
        initialInvocation: {
          scope: invocation.scope,
          mode: invocation.mode ?? "backfill",
        },
      },
    );
  }

  const scan = await buildRetitleScopeScan(ctx, invocation.scope);
  const mode = invocation.mode ?? "backfill";
  return runWithInFlightTracking(state, async () => {
    const result = await runBulkRetitle(
      pi,
      state.controller,
      ctx,
      modelRuntime,
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
