import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { consumePendingHandoffBootstrap } from "./session-handoff/bootstrap.ts";
import { getHandoffModelCompletions } from "./session-handoff/completions.ts";
import {
  generateHandoffDraftFromSessionManager,
  type HandoffDraftResult,
  resolveHandoffSource,
} from "./session-handoff/extract.ts";
import {
  buildHandoffKickoffMessage,
  buildHandoffKickoffSource,
  type HandoffKickoffMessage,
  type HandoffKickoffSource,
  registerHandoffKickoffRenderer,
} from "./session-handoff/kickoff.ts";
import type { ClipboardStatus } from "./session-handoff/launch/backend.ts";
import { createDeferredLaunchBackend } from "./session-handoff/launch/deferred.ts";
import {
  createGhosttyLaunchBackend,
  getFocusedGhosttyTerminalId,
  isGhosttyHandoffAvailable,
  validateSplitHandoffPrerequisites,
} from "./session-handoff/launch/ghostty.ts";
import {
  createHandoffBootstrap,
  createHandoffSessionMetadata,
  HANDOFF_METADATA_CUSTOM_TYPE,
} from "./session-handoff/metadata.ts";
import {
  formatModelArgument,
  type HandoffModelOverride,
  resolveModelOverride,
} from "./session-handoff/model.ts";
import { openSessionReferencePicker } from "./session-handoff/picker.ts";
import { SESSION_TOKEN_PREFIX } from "./session-handoff/query.ts";
import {
  buildLaunchReceipt,
  HANDOFF_LAUNCH_RECEIPT_CUSTOM_TYPE,
  registerHandoffLaunchReceiptRenderer,
} from "./session-handoff/receipt.ts";
import { reviewHandoffDraft } from "./session-handoff/review.ts";
import { prepareHandoffLaunch } from "./session-handoff/spawn.ts";
import {
  DEFERRED_LAUNCH,
  executeSessionHandoffTool,
  type HandoffLaunchTarget,
  type HandoffToolParams,
  LAUNCH_DIRECTIONS,
} from "./session-handoff/tool.ts";
import { HANDOFF_TOOL_DETAILS_SCHEMA } from "./session-handoff/tool-contract.ts";
import { HandoffToolComponent } from "./session-handoff/tool-renderer.ts";
import { buildHandoffToolView } from "./session-handoff/tool-view-model.ts";
import { formatHandoffError, runHandoffTaskWithLoader } from "./session-handoff/ui.ts";
import { formatAvailableModelList } from "./shared/model-resolution.ts";
import { isTuiMode } from "./shared/pi-mode.ts";
import { loadSettings } from "./shared/settings.ts";
import { THINKING_LEVELS } from "./shared/thinking-levels.ts";
import { safeParseTypeBoxValue } from "./shared/typebox.ts";

const HANDOFF_USAGE =
  "Usage: /handoff [--left|--right|--up|--down|--deferred] <goal for new thread>";
function handoffLaunchSchema(ghosttyAvailable: boolean) {
  const values: HandoffLaunchTarget[] = ghosttyAvailable
    ? [...LAUNCH_DIRECTIONS, DEFERRED_LAUNCH]
    : [DEFERRED_LAUNCH];
  const description = ghosttyAvailable
    ? "Where to launch the child session. 'deferred' creates the session and returns the resume command without opening anything; direction values open a Ghostty split. If the user does not make it clear which launch target to use, ask for clarification."
    : "Where to launch the child session. 'deferred' creates the session and returns the resume command without opening anything.";
  return Type.Union(
    values.map((value) => Type.Literal(value)),
    { description },
  );
}

function handoffModelDescription(models: readonly Model<Api>[]): string {
  const base =
    "Model for the child session as 'provider/model-id'. Defaults to the current session's model. Only override when the task clearly warrants a different model.";
  return models.length === 0
    ? `${base} No configured models are listed; leave blank to use the current session's model.`
    : `${base} Available models: ${formatAvailableModelList(models)}.`;
}

interface HandoffToolRendererState {
  callComponent?: HandoffToolComponent | undefined;
}

interface HandoffPromptContext {
  ui: ExtensionUIContext;
  sendMessage(message: HandoffKickoffMessage, options: { triggerTurn: true }): Promise<void>;
}

export default function sessionHandoffExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();
  let identifiedGhosttyTerminalId: string | undefined;
  let modelSnapshot: Model<Api>[] = [];
  const clipboardStatusBySessionId = new Map<string, ClipboardStatus>();

  registerHandoffKickoffRenderer(pi);
  registerHandoffLaunchReceiptRenderer(pi, (sessionId) =>
    clipboardStatusBySessionId.get(sessionId),
  );

  function registerHandoffTool(models: readonly Model<Api>[], ghosttyAvailable: boolean): void {
    pi.registerTool({
      name: "session_handoff",
      label: "Session Handoff",
      description:
        "Start a new background Pi session with directed instructions based on current work. The current session continues after launch.",
      promptSnippet:
        "Start a background pi session in a terminal split based on the current session",
      promptGuidelines: [
        "Use session_handoff only when it is clear the work should be forked to a new context.",
        "Reach for session_handoff by direction of the user, not as an unsolicited default.",
        "session_handoff should only request a response when there is a specific ask-and-response expectation: the user asked for a report back, or this session needs the child result to continue. Leave it off by default and for independent background work.",
        "session_handoff can only fork a background session; to replace the current session, tell the user to run /handoff instead.",
      ],
      executionMode: "sequential",
      parameters: Type.Object({
        goal: Type.String({
          description:
            "Goal for the new session. Capture enough detail to encompass the ask and any directions the next session should consider.",
        }),
        title: Type.String({
          description:
            "Short display title for the child session, 64 characters or less. Summarize the mission; do not repeat the full goal.",
        }),
        launch: handoffLaunchSchema(ghosttyAvailable),
        cwd: Type.Optional(
          Type.String({
            description:
              "Optional target working directory. Relative paths resolve from the current session cwd.",
          }),
        ),
        requestResponse: Type.Optional(
          Type.Boolean({
            description:
              "Whether the child session should report completion/results of its task back to this session.",
          }),
        ),
        model: Type.Optional(
          Type.String({
            description: handoffModelDescription(models),
          }),
        ),
        thinkingLevel: Type.Optional(
          Type.Union(
            THINKING_LEVELS.map((level) => Type.Literal(level)),
            {
              description:
                "Thinking level for the child session. Defaults to the current session's level, which is almost always correct. Override only when the user requests it.",
            },
          ),
        ),
      }),
      renderCall(args, theme, context) {
        const state = context.state as HandoffToolRendererState;
        const component = state.callComponent ?? new HandoffToolComponent(theme);
        state.callComponent = component;
        component.update(buildHandoffToolView(args), context.expanded);
        return component;
      },
      renderResult(result, options, theme, context) {
        const text = getFirstText(result);
        if (context.isError) {
          return new Text(theme.fg("error", text), 0, 0);
        }

        const details = safeParseTypeBoxValue(HANDOFF_TOOL_DETAILS_SCHEMA, result.details);
        const state = context.state as HandoffToolRendererState;
        if (!details || !state.callComponent) {
          return new Text(text, 0, 0);
        }

        state.callComponent.update(
          buildHandoffToolView(context.args, details),
          options.expanded,
          clipboardStatusBySessionId.get(details.sessionId),
        );
        return new Text("", 0, 0);
      },
      async execute(_toolCallId, params: HandoffToolParams, _signal, _onUpdate, ctx) {
        return executeSessionHandoffTool(
          pi,
          params,
          ctx,
          identifiedGhosttyTerminalId,
          settings.handoff.deferred.copyToClipboard,
          (sessionId, status) => clipboardStatusBySessionId.set(sessionId, status),
        );
      },
    });
  }

  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session",
    getArgumentCompletions: (argumentPrefix: string) =>
      getHandoffModelCompletions(argumentPrefix, modelSnapshot),
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      if (!isTuiMode(ctx)) {
        ctx.ui.notify("handoff requires interactive mode", "error");
        return;
      }

      const parsedArgs = parseHandoffCommandArgs(args);
      if (parsedArgs.kind === "error") {
        ctx.ui.notify(parsedArgs.message, "error");
        return;
      }

      if (parsedArgs.kind === "identify") {
        const terminalId = await getFocusedGhosttyTerminalId(pi, ctx.cwd);
        if (!terminalId) {
          ctx.ui.notify("Unable to identify the focused Ghostty terminal.", "error");
          return;
        }

        identifiedGhosttyTerminalId = terminalId;
        ctx.ui.notify(`Identified Ghostty terminal ${terminalId}.`, "info");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      const sourceLeafId = ctx.sessionManager.getLeafId();
      if (!sourceLeafId) {
        ctx.ui.notify("No conversation to hand off", "error");
        return;
      }
      try {
        resolveHandoffSource(ctx.sessionManager, sourceLeafId);
      } catch (error) {
        ctx.ui.notify(formatHandoffError(error), "error");
        return;
      }

      let resolvedOverride: HandoffModelOverride | undefined;
      if (parsedArgs.model) {
        try {
          resolvedOverride = resolveModelOverride(ctx.modelRegistry, parsedArgs.model);
        } catch (error) {
          ctx.ui.notify(formatHandoffError(error), "error");
          return;
        }
      }

      if (parsedArgs.launch && parsedArgs.launch !== DEFERRED_LAUNCH) {
        const preflightError = await validateSplitHandoffPrerequisites(ctx);
        if (preflightError) {
          ctx.ui.notify(preflightError, "error");
          return;
        }
      }

      let generatedDraft: HandoffDraftResult | undefined;
      try {
        generatedDraft = await runHandoffTaskWithLoader(
          ctx,
          "Generating handoff draft...",
          async (signal: AbortSignal) =>
            generateHandoffDraftFromSessionManager(
              ctx,
              ctx.sessionManager,
              sourceLeafId,
              parsedArgs.goal,
              pi.getThinkingLevel(),
              signal,
            ),
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

      const parentSessionFile = ctx.sessionManager.getSessionFile();
      if (!parentSessionFile) {
        ctx.ui.notify("Handoff requires a persisted current session.", "error");
        return;
      }

      const handoffMetadata = createHandoffSessionMetadata(
        parsedArgs.goal,
        generatedDraft.context.nextTask,
        approvedDraft,
        generatedDraft.context.title,
      );
      const sourceSessionName = ctx.sessionManager.getSessionName();
      const kickoffSource = buildHandoffKickoffSource({
        sessionId: ctx.sessionManager.getSessionId(),
        ...(sourceSessionName ? { sessionName: sourceSessionName } : {}),
      });
      const model = formatModelArgument(
        resolvedOverride?.model ?? ctx.model,
        resolvedOverride?.thinkingLevel ?? pi.getThinkingLevel(),
      );
      if (parsedArgs.launch) {
        if (!model) {
          ctx.ui.notify("No active model is available for the handoff.", "error");
          return;
        }
        const prepared = prepareHandoffLaunch({
          targetCwd: ctx.cwd,
          parentCwd: ctx.cwd,
          parentSessionDir: ctx.sessionManager.getSessionDir(),
          parentSessionFile,
          title: handoffMetadata.title,
          model,
          buildBootstrap: (sessionId) =>
            createHandoffBootstrap(sessionId, handoffMetadata, kickoffSource),
        });

        const appendLaunchReceipt = (launch: HandoffLaunchTarget, backend?: string): void => {
          pi.appendEntry(
            HANDOFF_LAUNCH_RECEIPT_CUSTOM_TYPE,
            buildLaunchReceipt({
              sessionId: prepared.sessionId,
              title: handoffMetadata.title,
              launch,
              resumeCommand: prepared.resumeCommand,
              backend,
              targetCwd: ctx.cwd,
              parentCwd: ctx.cwd,
              childModel: model,
            }),
          );
        };

        if (parsedArgs.launch === DEFERRED_LAUNCH) {
          const outcome = await createDeferredLaunchBackend({
            copyToClipboard: settings.handoff.deferred.copyToClipboard,
          }).launch({
            cwd: ctx.cwd,
            title: handoffMetadata.title,
            resumeCommand: prepared.resumeCommand,
          });
          if (outcome.success && outcome.clipboardStatus) {
            clipboardStatusBySessionId.set(prepared.sessionId, outcome.clipboardStatus);
          }

          appendLaunchReceipt(DEFERRED_LAUNCH);
          return;
        }

        const backend = createGhosttyLaunchBackend(pi, {
          direction: parsedArgs.launch,
          terminalId: identifiedGhosttyTerminalId,
          fallbackToFocusedOnError: true,
        });
        const outcome = await backend.launch({
          cwd: ctx.cwd,
          title: handoffMetadata.title,
          resumeCommand: prepared.resumeCommand,
        });

        if (!outcome.success) {
          ctx.ui.notify(
            `${outcome.error} Created handoff session ${prepared.sessionId}; start it manually with: ${prepared.resumeCommand}`,
            "error",
          );
          return;
        }

        appendLaunchReceipt(parsedArgs.launch, "Ghostty");
        return;
      }

      const switchResult = await ctx.newSession({
        parentSession: parentSessionFile,
        setup: async (sessionManager) => {
          sessionManager.appendSessionInfo(handoffMetadata.title);
          sessionManager.appendCustomEntry(HANDOFF_METADATA_CUSTOM_TYPE, handoffMetadata);
        },
        withSession: async (nextCtx) => {
          await applyHandoffModelOverride(pi, nextCtx, resolvedOverride);
          startHandoffPromptAfterSessionRender(nextCtx, {
            prompt: approvedDraft,
            title: handoffMetadata.title,
            source: kickoffSource,
          });
        },
      });

      if (switchResult.cancelled) {
        ctx.ui.notify("Session switch cancelled", "info");
      }
    },
  });

  pi.registerShortcut(settings.handoff.pickerShortcut, {
    description: "Open the session reference picker",
    handler: async (ctx) => {
      if (!isTuiMode(ctx)) {
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
    modelSnapshot = ctx.modelRegistry.getAvailable();
    registerHandoffTool(modelSnapshot, isGhosttyHandoffAvailable());

    await consumePendingHandoffBootstrap(pi, ctx, pi.getThinkingLevel());
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (isGhosttyHandoffAvailable() && ctx) {
      identifiedGhosttyTerminalId =
        (await getFocusedGhosttyTerminalId(pi, ctx.cwd)) ?? identifiedGhosttyTerminalId;
    }

    return {
      systemPrompt:
        event.systemPrompt +
        "\n\nWhen the user references @session:<uuid>, treat it as a session token. If you call session_ask, pass only the UUID value, not the @session: prefix.",
    };
  });
}

async function applyHandoffModelOverride(
  pi: ExtensionAPI,
  ctx: { ui: ExtensionUIContext },
  override: HandoffModelOverride | undefined,
): Promise<void> {
  if (!override) {
    return;
  }

  const applied = await pi.setModel(override.model);
  if (!applied) {
    ctx.ui.notify(
      "Handoff model override could not be applied; continuing with the current model.",
      "info",
    );
    return;
  }

  if (override.thinkingLevel) {
    pi.setThinkingLevel(override.thinkingLevel);
  }
}

function startHandoffPromptAfterSessionRender(
  ctx: HandoffPromptContext,
  kickoff: { prompt: string; title: string; source: HandoffKickoffSource },
): void {
  // ctx.newSession() renders the replacement session only after withSession returns.
  setImmediate(() => {
    void (async () => {
      try {
        await ctx.sendMessage(buildHandoffKickoffMessage(kickoff), { triggerTurn: true });
      } catch (error) {
        ctx.ui.notify(formatHandoffError(error), "error");
      }
    })();
  });
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

function parseHandoffCommandArgs(args: string):
  | { kind: "identify" }
  | {
      kind: "ok";
      goal: string;
      launch?: HandoffLaunchTarget | undefined;
      model?: string | undefined;
    }
  | { kind: "error"; message: string } {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  if (tokens.includes("--identify")) {
    return { kind: "identify" };
  }

  if (tokens.length === 0) {
    return { kind: "error", message: HANDOFF_USAGE };
  }

  const launchFlags = new Map<string, HandoffLaunchTarget>([
    ["--left", "left"],
    ["--right", "right"],
    ["--up", "up"],
    ["--down", "down"],
    ["--deferred", DEFERRED_LAUNCH],
  ]);

  let launch: HandoffLaunchTarget | undefined;
  let model: string | undefined;
  const goalTokens: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;

    if (token === "--model") {
      const value = tokens[i + 1];
      if (!value) {
        return { kind: "error", message: HANDOFF_USAGE };
      }

      model = value;
      i++;
      continue;
    }

    const target = launchFlags.get(token);
    if (!target) {
      goalTokens.push(token);
      continue;
    }

    if (launch) {
      return {
        kind: "error",
        message: "Use only one launch target: --left, --right, --up, --down, or --deferred.",
      };
    }

    launch = target;
  }

  const goal = goalTokens.join(" ").trim();
  if (!goal) {
    return { kind: "error", message: HANDOFF_USAGE };
  }

  return {
    kind: "ok",
    goal,
    launch,
    model,
  };
}
