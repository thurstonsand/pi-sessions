import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { buildSessionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { generateHandoffDraft, type HandoffDraftResult } from "./session-handoff/extract.js";
import {
  createHandoffSessionMetadata,
  createPendingSendConsumedEntry,
  getPendingInitialPromptFromEntries,
  HANDOFF_METADATA_CUSTOM_TYPE,
  PENDING_SEND_CONSUMED_CUSTOM_TYPE,
} from "./session-handoff/metadata.js";
import { openSessionReferencePicker } from "./session-handoff/picker.js";
import { SESSION_TOKEN_PREFIX } from "./session-handoff/query.js";
import { renderStrongModal, reviewHandoffDraft } from "./session-handoff/review.js";
import { loadSettings } from "./shared/settings.js";

export default function sessionHandoffExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();

  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
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
        generatedDraft = await runWithLoader(
          ctx,
          "Generating handoff draft...",
          async (signal: AbortSignal) => generateHandoffDraft(ctx, goal, signal),
        );
      } catch (error) {
        ctx.ui.notify(formatHandoffError(error), "error");
        return;
      }

      if (!generatedDraft) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      const approvedDraft = await reviewHandoffDraft(ctx, generatedDraft.draft);
      if (!approvedDraft) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      const parentSession = ctx.sessionManager.getSessionFile();

      const handoffMetadata = createHandoffSessionMetadata(
        goal,
        generatedDraft.context.nextTask,
        approvedDraft,
      );
      const writeMetadata = async (sm: SessionManager) => {
        sm.appendCustomEntry(HANDOFF_METADATA_CUSTOM_TYPE, handoffMetadata);
      };
      const newSessionResult = parentSession
        ? await ctx.newSession({ parentSession, setup: writeMetadata })
        : await ctx.newSession({ setup: writeMetadata });

      if (newSessionResult.cancelled) {
        ctx.ui.notify("New session cancelled", "info");
        return;
      }

      ctx.ui.notify("Handoff started in a new session.", "info");
    },
  });

  pi.registerShortcut(settings.handoff.pickerShortcut, {
    description: "Open the session reference picker",
    handler: async (ctx) => {
      if (!ctx.hasUI) {
        return;
      }

      const result = await openSessionReferencePicker(
        ctx,
        settings.index.path,
        settings.handoff.pickerShortcut,
      );
      if (result.kind !== "insert-session-token") {
        return;
      }

      ctx.ui.pasteToEditor(`${SESSION_TOKEN_PREFIX}${result.sessionId}`);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const pending = getPendingInitialPromptFromEntries(ctx.sessionManager.getEntries());

    if (!sessionFile || !pending) {
      return;
    }

    pi.appendEntry(
      PENDING_SEND_CONSUMED_CUSTOM_TYPE,
      createPendingSendConsumedEntry(pending.initial_prompt_nonce),
    );
    pi.sendUserMessage(pending.initial_prompt);
  });

  pi.on("before_agent_start", async () => {
    return {
      systemPrompt:
        "When the user references @session:<uuid>, treat it as a session token. If you call session_ask, pass only the UUID value, not the @session: prefix.",
    };
  });
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
