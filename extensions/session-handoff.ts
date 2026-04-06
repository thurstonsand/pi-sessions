import type {
  EventBus,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  KeybindingsManager,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { buildSessionContext } from "@mariozechner/pi-coding-agent";
import { type EditorTheme, Key, matchesKey, type TUI } from "@mariozechner/pi-tui";
import { HandoffAutocompleteEditor, isToggleScopeInput } from "./session-handoff/autocomplete.js";
import { generateHandoffDraft, type HandoffDraftResult } from "./session-handoff/extract.js";
import {
  createHandoffSessionMetadata,
  createPendingSendConsumedEntry,
  getPendingInitialPromptFromEntries,
  HANDOFF_METADATA_CUSTOM_TYPE,
  PENDING_SEND_CONSUMED_CUSTOM_TYPE,
} from "./session-handoff/metadata.js";
import { connectPowerlineHandoffAutocomplete } from "./session-handoff/powerline.js";
import { renderStrongModal, reviewHandoffDraft } from "./session-handoff/review.js";
import { loadSettings, type SessionSettings } from "./shared/settings.js";

const AUTOCOMPLETE_HINT_KEY = "pi-sessions.session-autocomplete";
const POWERLINE_AUTOCOMPLETE_TIMEOUT_MS = 150;
const POWERLINE_AUTOCOMPLETE_ATTACH_TIMEOUT_MS = 10_000;
const POWERLINE_EXTENSION_ID = "pi-sessions";

interface InstalledHandoffAutocomplete {
  mode: "standalone" | "powerline";
  dispose(): void;
}

let installedAutocomplete: InstalledHandoffAutocomplete | undefined;

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

  pi.on("session_start", async (_event, ctx) => {
    void installHandoffAutocomplete(ctx, pi.events, settings).catch((error: unknown) => {
      if (!ctx.hasUI) {
        return;
      }

      ctx.ui.notify(formatHandoffError(error), "error");
    });

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

  pi.on("session_shutdown", async () => {
    installedAutocomplete?.dispose();
    installedAutocomplete = undefined;
  });

  pi.on("before_agent_start", async () => {
    return {
      systemPrompt:
        "When the user references @session:<uuid>, treat it as a session token. If you call session_ask, pass only the UUID value, not the @session: prefix.",
    };
  });
}

export async function installHandoffAutocomplete(
  ctx: ExtensionContext,
  events: EventBus,
  settings: SessionSettings,
): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  installedAutocomplete?.dispose();
  installedAutocomplete = undefined;
  ctx.ui.setWidget(AUTOCOMPLETE_HINT_KEY, undefined);

  if (settings.handoff.editorMode === "standalone") {
    installedAutocomplete = installStandaloneHandoffAutocomplete(ctx, settings.index.path);
    return;
  }

  const result = await tryPowerlineHandoffAutocomplete(ctx, events, settings.index.path);
  if (result) {
    installedAutocomplete = result;
    return;
  }

  ctx.ui.notify(
    'sessions.handoff.editor is set to "powerline", but the Powerline autocomplete bridge is unavailable.',
    "error",
  );
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

function installStandaloneHandoffAutocomplete(
  ctx: ExtensionContext,
  indexPath: string,
): InstalledHandoffAutocomplete {
  let currentEditor: HandoffAutocompleteEditor | undefined;
  let autocompleteFixed = false;

  // Pi calls setAutocompleteProvider asynchronously after the editor is created.
  // If the user types before the provider arrives, re-install the editor to let
  // Pi attach the provider on the next creation cycle.
  const editorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
    const editor = new HandoffAutocompleteEditor(tui, theme, keybindings, {
      indexPath,
      getCurrentSessionPath: () => ctx.sessionManager.getSessionFile(),
      getCurrentCwd: () => ctx.cwd,
      setAutocompleteStatus: (text: string | undefined) => {
        if (!text) {
          ctx.ui.setWidget(AUTOCOMPLETE_HINT_KEY, undefined);
          return;
        }

        ctx.ui.setWidget(AUTOCOMPLETE_HINT_KEY, [text], {
          placement: "belowEditor",
        });
      },
    });
    const originalHandleInput = editor.handleInput.bind(editor);
    editor.handleInput = (data: string) => {
      if (!autocompleteFixed && !editor.hasAutocompleteProviderAttached()) {
        autocompleteFixed = true;
        ctx.ui.setEditorComponent(editorFactory);
        currentEditor?.handleInput(data);
        return;
      }

      originalHandleInput(data);
    };
    currentEditor = editor;
    return editor;
  };

  ctx.ui.setEditorComponent(editorFactory);

  return {
    mode: "standalone",
    dispose() {
      ctx.ui.setWidget(AUTOCOMPLETE_HINT_KEY, undefined);
    },
  };
}

async function tryPowerlineHandoffAutocomplete(
  ctx: ExtensionContext,
  events: EventBus,
  indexPath: string,
): Promise<InstalledHandoffAutocomplete | null> {
  const connection = await connectPowerlineHandoffAutocomplete(events, {
    extension: { id: POWERLINE_EXTENSION_ID },
    indexPath,
    getCurrentSessionPath: () => ctx.sessionManager.getSessionFile(),
    getCurrentCwd: () => ctx.cwd,
    pingTimeoutMs: POWERLINE_AUTOCOMPLETE_TIMEOUT_MS,
    attachTimeoutMs: POWERLINE_AUTOCOMPLETE_ATTACH_TIMEOUT_MS,
  });

  if (!connection) {
    return null;
  }

  let includeAllSessions = false;
  const unsubscribeState = connection.interaction.subscribe((isActive: boolean) => {
    if (!isActive) {
      includeAllSessions = false;
    }
  });

  const unsubscribeInput = ctx.ui.onTerminalInput((data: string) => {
    if (!isToggleScopeInput(data) || !connection.interaction.isActive()) {
      return undefined;
    }

    includeAllSessions = !includeAllSessions;
    connection.interaction.requestRefresh({ includeAllSessions });
    return { consume: true };
  });

  return {
    mode: "powerline",
    dispose() {
      ctx.ui.setWidget(AUTOCOMPLETE_HINT_KEY, undefined);
      unsubscribeState();
      unsubscribeInput();
      connection.disconnect();
    },
  };
}

function formatHandoffError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "Handoff generation failed.";
}
