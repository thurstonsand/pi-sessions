import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { buildSessionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { generateHandoffDraft, type HandoffDraftResult } from "./session-handoff/extract.js";
import {
  createHandoffSessionMetadata,
  HANDOFF_METADATA_CUSTOM_TYPE,
} from "./session-handoff/metadata.js";
import { renderStrongModal, reviewHandoffDraft } from "./session-handoff/review.js";
import { clearPendingChildOrigin, queuePendingChildOrigin } from "./session-search/hooks.js";

interface HandoffCommandDependencies {
  generateDraft: (
    ctx: ExtensionCommandContext,
    goal: string,
    signal?: AbortSignal,
  ) => Promise<HandoffDraftResult | undefined>;
  reviewDraft: (ctx: ExtensionCommandContext, draft: string) => Promise<string | undefined>;
  runWithLoader: <T>(
    ctx: ExtensionCommandContext,
    label: string,
    task: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T | undefined>;
}

const defaultDependencies: HandoffCommandDependencies = {
  generateDraft: generateHandoffDraft,
  reviewDraft: reviewHandoffDraft,
  runWithLoader: runWithLoader,
};

export default function sessionHandoffExtension(pi: ExtensionAPI): void {
  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session",
    handler: createSessionHandoffCommandHandler(pi),
  });
}

export function createSessionHandoffCommandHandler(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  dependencies: HandoffCommandDependencies = defaultDependencies,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (!ctx.hasUI) {
      ctx.ui.notify("handoff requires interactive mode", "error");
      return;
    }

    if (!ctx.model) {
      ctx.ui.notify("No model selected", "error");
      return;
    }

    const goal = args.trim();
    if (!goal) {
      ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
      return;
    }

    const sessionContext = buildSessionContext(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getLeafId(),
    );
    if (sessionContext.messages.length === 0) {
      ctx.ui.notify("No conversation to hand off", "error");
      return;
    }

    let generatedDraft: HandoffDraftResult | undefined;
    try {
      generatedDraft = await dependencies.runWithLoader(
        ctx,
        "Generating handoff draft...",
        async (signal: AbortSignal) => dependencies.generateDraft(ctx, goal, signal),
      );
    } catch (error) {
      ctx.ui.notify(formatHandoffError(error), "error");
      return;
    }

    if (!generatedDraft) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const approvedDraft = await dependencies.reviewDraft(ctx, generatedDraft.draft);
    if (!approvedDraft) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const parentSession = ctx.sessionManager.getSessionFile();
    if (parentSession) {
      queuePendingChildOrigin(parentSession, "handoff");
    }

    const handoffMetadata = createHandoffSessionMetadata(goal, generatedDraft.context.nextTask);
    const writeMetadata = async (sm: { appendCustomEntry(type: string, data: unknown): void }) => {
      sm.appendCustomEntry(HANDOFF_METADATA_CUSTOM_TYPE, handoffMetadata);
    };
    const newSessionResult = parentSession
      ? await ctx.newSession({ parentSession, setup: writeMetadata })
      : await ctx.newSession({ setup: writeMetadata });

    if (newSessionResult.cancelled) {
      if (parentSession) {
        clearPendingChildOrigin(parentSession);
      }
      ctx.ui.notify("New session cancelled", "info");
      return;
    }

    pi.sendUserMessage(approvedDraft);
    ctx.ui.notify("Handoff started in a new session.", "info");
  };
}

async function runWithLoader<T>(
  ctx: ExtensionCommandContext,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  let taskError: unknown;

  const result = await ctx.ui.custom<T | undefined>(
    (tui, theme, _keybindings, done) => {
      const abortController = new AbortController();

      task(abortController.signal)
        .then(done)
        .catch((error: unknown) => {
          if (!abortController.signal.aborted) {
            taskError = error;
          }
          done(undefined);
        });

      return {
        render(width: number): string[] {
          return renderStrongModal(
            [theme.fg("accent", theme.bold(label)), "", theme.fg("muted", "Press Esc to cancel.")],
            width,
            theme,
          );
        },
        invalidate(): void {},
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            abortController.abort();
            done(undefined);
            tui.requestRender();
          }
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "70%",
        maxHeight: "40%",
        margin: 2,
      },
    },
  );

  if (taskError) {
    throw taskError;
  }

  return result;
}

function formatHandoffError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "Handoff generation failed.";
}
