import type { Api, Model } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
  TurnEndEvent,
} from "@mariozechner/pi-coding-agent";
import {
  createSessionAutoTitleCommandHandler,
  getRetitleArgumentCompletions,
  type RetitleCommandInvocation,
  type RetitleCommandOutcome,
} from "./session-auto-title/command.js";
import {
  createSessionAutoTitleController,
  type SessionAutoTitleController,
} from "./session-auto-title/controller.js";
import { resolveAutoTitleModel } from "./session-auto-title/model.js";
import {
  buildRetitleScopeScan,
  notifyBulkRetitleResult,
  persistAutoTitleState,
  runBulkRetitle,
  runRetitlePlan,
} from "./session-auto-title/retitle.js";
import { showRetitleWizard } from "./session-auto-title/wizard.js";
import { loadSettings } from "./shared/settings.js";

export {
  createSessionAutoTitleCommandHandler,
  getRetitleArgumentCompletions,
  parseRetitleCommand,
  TITLE_USAGE,
} from "./session-auto-title/command.js";

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
  let resolvedModel: Model<Api> | undefined;

  pi.registerCommand("title", {
    description: "Generate titles for this session, this folder, or all of Pi",
    getArgumentCompletions: getRetitleArgumentCompletions,
    handler: createSessionAutoTitleCommandHandler(
      async (invocation, ctx): Promise<RetitleCommandOutcome> => {
        if (titleWorkInFlight) {
          await titleWorkInFlight;
        }

        const model = resolvedModel ?? resolveAutoTitleModel(ctx, settings.autoTitle.model)?.model;
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
          model,
          invocation,
        );
      },
    ),
  });

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    sessionEpoch += 1;
    resolvedModel = resolveAutoTitleModel(ctx, settings.autoTitle.model)?.model;
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
      model: resolvedModel,
      isManual: false,
      existingPlan: result.plan,
      getSessionEpoch: () => sessionEpoch,
      notifyOnSuccess: false,
    })
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        titleWorkInFlight = undefined;
      });
  });

  pi.on("session_shutdown", async () => {
    sessionEpoch += 1;
    controller.handleSessionShutdown();
    titleWorkInFlight = undefined;
    resolvedModel = undefined;
  });
}

async function handleTitleInvocation(
  pi: ExtensionAPI,
  state: TitleRunState,
  ctx: ExtensionCommandContext,
  model: Model<Api> | undefined,
  invocation: RetitleCommandInvocation,
): Promise<RetitleCommandOutcome> {
  const retitleOpts = {
    pi,
    controller: state.controller,
    ctx,
    model,
    isManual: true,
    getSessionEpoch: state.getSessionEpoch,
  };

  const retitleCurrentSession = async (): Promise<RetitleCommandOutcome> =>
    (await runRetitlePlan(retitleOpts)) ? "success" : "failed";

  if (invocation.kind === "open-pane") {
    if (!ctx.hasUI) {
      return retitleCurrentSession();
    }

    return showRetitleWizard(pi, state.controller, ctx, model, state.getSessionEpoch);
  }

  if (invocation.scope === "this") {
    return runWithInFlightTracking(state, retitleCurrentSession);
  }

  if (ctx.hasUI && !invocation.force) {
    return showRetitleWizard(pi, state.controller, ctx, model, state.getSessionEpoch, {
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
