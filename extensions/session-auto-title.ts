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
  SessionStartEvent,
  TurnEndEvent,
} from "@mariozechner/pi-coding-agent";
import { buildAutoTitleContext } from "./session-auto-title/context.js";
import {
  type AutoTitleTriggerPlan,
  createSessionAutoTitleController,
  type SessionAutoTitleController,
} from "./session-auto-title/controller.js";
import { resolveAutoTitleModel } from "./session-auto-title/model.js";
import {
  AUTO_TITLE_SYSTEM_PROMPT,
  buildAutoTitlePrompt,
  normalizeGeneratedAutoTitle,
} from "./session-auto-title/prompt.js";
import {
  AUTO_TITLE_STATE_CUSTOM_TYPE,
  type AutoTitlePersistedState,
} from "./session-auto-title/state.js";
import { loadSettings } from "./shared/settings.js";

const AUTO_TITLE_REQUEST_TIMEOUT_MS = 15_000;
const AUTO_TITLE_MAX_TOKENS = 64;

export default function sessionAutoTitleExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();
  const controller = createSessionAutoTitleController(settings.autoTitle);
  let sessionEpoch = 0;
  let retitleInFlight: Promise<boolean> | undefined;
  let resolvedModel: Model<Api> | undefined;

  pi.registerCommand("retitle", {
    description: "Regenerate the current session title from the active branch",
    handler: createSessionAutoTitleCommandHandler(async (ctx) => {
      if (retitleInFlight) {
        await retitleInFlight;
      }

      const work = runRetitlePlan(
        pi,
        controller,
        ctx,
        resolvedModel,
        true,
        undefined,
        () => sessionEpoch,
      )
        .catch(() => false)
        .finally(() => {
          retitleInFlight = undefined;
        });
      retitleInFlight = work;
      return work;
    }),
  });

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    sessionEpoch += 1;
    resolvedModel = resolveAutoTitleModel(ctx, settings.autoTitle.model)?.model;
    persistAutoTitleState(pi, controller.handleSessionStart(ctx));
  });

  pi.on("turn_end", async (_event: TurnEndEvent, ctx: ExtensionContext) => {
    const result = controller.handleTurnEnd(ctx);
    persistAutoTitleState(pi, result.persistedState);

    if (!result.plan || retitleInFlight) {
      return;
    }

    retitleInFlight = runRetitlePlan(
      pi,
      controller,
      ctx,
      resolvedModel,
      false,
      result.plan,
      () => sessionEpoch,
    )
      .catch(() => false)
      .finally(() => {
        retitleInFlight = undefined;
      });
  });

  pi.on("session_shutdown", async () => {
    sessionEpoch += 1;
    controller.handleSessionShutdown();
    retitleInFlight = undefined;
    resolvedModel = undefined;
  });
}

export function createSessionAutoTitleCommandHandler(
  runRetitle: (ctx: ExtensionCommandContext) => Promise<boolean>,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (args.trim()) {
      ctx.ui.notify("Usage: /retitle", "error");
      return;
    }

    await ctx.waitForIdle();

    const didRetitle = await runRetitle(ctx);
    if (!didRetitle) {
      ctx.ui.notify("Session retitle failed.", "error");
    }
  };
}

async function runRetitlePlan(
  pi: ExtensionAPI,
  controller: SessionAutoTitleController,
  ctx: ExtensionContext,
  model: Model<Api> | undefined,
  isManual: boolean,
  existingPlan?: AutoTitleTriggerPlan,
  getSessionEpoch?: () => number,
): Promise<boolean> {
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

  persistAutoTitleState(pi, controller.handleTitleApplied(generatedTitle, plan));

  if (isManual && ctx.hasUI) {
    ctx.ui.notify(`Retitled session: ${generatedTitle}`, "info");
  }

  return true;
}

function persistAutoTitleState(pi: ExtensionAPI, state: AutoTitlePersistedState | undefined): void {
  if (!state) {
    return;
  }

  pi.appendEntry(AUTO_TITLE_STATE_CUSTOM_TYPE, state);
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
        ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers ? { headers: auth.headers } : {}),
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
