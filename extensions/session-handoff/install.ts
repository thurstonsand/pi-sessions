import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { IndexHandle, SessionLifecycle } from "../shared/composition.ts";
import type { ModelRuntimeProvider } from "../shared/model-runtime.ts";
import { isTuiMode } from "../shared/pi-mode.ts";
import type { SessionSettings } from "../shared/settings.ts";
import { THINKING_LEVELS } from "../shared/thinking-levels.ts";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";
import { consumePendingHandoffBootstrap } from "./bootstrap.ts";
import { parseHandoffCommandArgs } from "./command.ts";
import { getHandoffModelCompletions } from "./completions.ts";
import {
  generateHandoffDraftFromSessionManager,
  type HandoffDraftResult,
  resolveHandoffSource,
} from "./extract.ts";
import {
  buildHandoffKickoffMessage,
  buildHandoffKickoffSource,
  HANDOFF_KICKOFF_CUSTOM_TYPE,
  type HandoffKickoffMessage,
  type HandoffKickoffSource,
  renderHandoffKickoffMessage,
} from "./kickoff.ts";
import type { ClipboardStatus } from "./launch/backend.ts";
import { createDeferredLaunchBackend } from "./launch/deferred.ts";
import {
  resolveSplitLaunchBackend,
  validateSplitHandoffPrerequisites,
} from "./launch/resolution.ts";
import { createHandoffLaunchTargets } from "./launch-options.ts";
import type { HandoffLaunchTarget, HandoffLaunchValue } from "./launch-target.ts";
import {
  createHandoffBootstrap,
  createHandoffSessionMetadata,
  HANDOFF_METADATA_CUSTOM_TYPE,
} from "./metadata.ts";
import { formatModelArgument, type HandoffModelOverride, resolveModelOverride } from "./model.ts";
import { openSessionReferencePicker } from "./picker.ts";
import { SESSION_TOKEN_PREFIX } from "./query.ts";
import {
  buildLaunchReceipt,
  createHandoffLaunchReceiptRenderer,
  HANDOFF_LAUNCH_RECEIPT_CUSTOM_TYPE,
} from "./receipt.ts";
import { reviewHandoffDraft } from "./review.ts";
import { prepareHandoffLaunch } from "./spawn.ts";
import {
  DEFERRED_LAUNCH,
  executeSessionHandoffTool,
  type HandoffToolParams,
  MAX_HANDOFF_TITLE_LENGTH,
} from "./tool.ts";
import { HANDOFF_TOOL_DETAILS_SCHEMA } from "./tool-contract.ts";
import { HandoffToolComponent } from "./tool-renderer.ts";
import {
  buildHandoffLaunchSchema,
  buildHandoffModelDescription,
  buildHandoffPromptGuidelines,
} from "./tool-schema.ts";
import { buildHandoffToolView } from "./tool-view-model.ts";
import { formatHandoffError, runHandoffTaskWithLoader } from "./ui.ts";

interface HandoffToolRendererState {
  callComponent?: HandoffToolComponent | undefined;
}

interface HandoffPromptContext {
  ui: ExtensionUIContext;
  sendMessage(message: HandoffKickoffMessage, options: { triggerTurn: true }): Promise<void>;
}

export function installHandoff(
  pi: ExtensionAPI,
  deps: {
    settings: SessionSettings;
    index: IndexHandle;
    getModelRuntime: ModelRuntimeProvider;
    getLaunchTargets?: (() => readonly HandoffLaunchTarget[]) | undefined;
  },
): SessionLifecycle {
  const { settings } = deps;
  const indexPath = deps.index.path;
  let identifiedGhosttyTerminalId: string | undefined;
  let modelSnapshot: Model<Api>[] = [];
  const clipboardStatusBySessionId = new Map<string, ClipboardStatus>();
  const splitBackend = resolveSplitLaunchBackend(pi, {
    getTerminalId: () => identifiedGhosttyTerminalId,
  });

  pi.registerMessageRenderer(HANDOFF_KICKOFF_CUSTOM_TYPE, renderHandoffKickoffMessage);
  pi.registerEntryRenderer(
    HANDOFF_LAUNCH_RECEIPT_CUSTOM_TYPE,
    createHandoffLaunchReceiptRenderer((sessionId) => clipboardStatusBySessionId.get(sessionId)),
  );

  function registerHandoffTool(
    models: readonly Model<Api>[],
    launchTargets: readonly HandoffLaunchTarget[],
  ): void {
    pi.registerTool({
      name: "session_handoff",
      label: "Session Handoff",
      description: "Start a new Pi session with a self-contained task.",
      promptSnippet:
        "Delegate bounded work to a background subagent or hand off context to another Pi session",
      promptGuidelines: buildHandoffPromptGuidelines(launchTargets),
      parameters: Type.Object({
        goal: Type.String({
          description:
            "Self-contained briefing that explains the objective, relevant context, constraints, and expected result.",
        }),
        title: Type.String({
          maxLength: MAX_HANDOFF_TITLE_LENGTH,
          description:
            "Short display title for the child session, 64 characters or less. Summarize the mission; do not repeat the full goal.",
        }),
        launch: buildHandoffLaunchSchema(launchTargets),
        cwd: Type.Optional(
          Type.String({
            description: "Optional target working directory (defaults to current).",
          }),
        ),
        requestResponse: Type.Optional(
          Type.Boolean({
            description:
              "Whether the child session should report completion/results of its task back to this session. Defaults to true for subagent launches and false otherwise.",
          }),
        ),
        model: Type.Optional(
          Type.String({
            description: buildHandoffModelDescription(models),
          }),
        ),
        thinkingLevel: Type.Optional(
          Type.Union(
            THINKING_LEVELS.map((level) => Type.Literal(level)),
            {
              description:
                "Thinking level for the child session. For directional or deferred, override only when the user requests it.",
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
        const modelRuntime = await deps.getModelRuntime(ctx.modelRegistry);
        return executeSessionHandoffTool(
          pi,
          params,
          ctx,
          modelRuntime,
          launchTargets,
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
        if (!splitBackend?.identifyTerminalId) {
          ctx.ui.notify("--identify applies to Ghostty splits.", "error");
          return;
        }
        const terminalId = await splitBackend.identifyTerminalId(ctx.cwd);
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

      let modelRuntime: ModelRuntime;
      try {
        modelRuntime = await deps.getModelRuntime(ctx.modelRegistry);
      } catch (error) {
        ctx.ui.notify(formatHandoffError(error), "error");
        return;
      }

      let resolvedOverride: HandoffModelOverride | undefined;
      if (parsedArgs.model) {
        try {
          resolvedOverride = resolveModelOverride(modelRuntime, parsedArgs.model);
        } catch (error) {
          ctx.ui.notify(formatHandoffError(error), "error");
          return;
        }
      }

      if (parsedArgs.launch && parsedArgs.launch !== DEFERRED_LAUNCH) {
        const preflightError = validateSplitHandoffPrerequisites(ctx, splitBackend);
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
              modelRuntime,
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

        const appendLaunchReceipt = (launch: HandoffLaunchValue, backend?: string): void => {
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

        if (!splitBackend) {
          throw new Error("Split launch backend became unavailable after preflight.");
        }
        const backend = splitBackend.create(parsedArgs.launch);
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

        appendLaunchReceipt(parsedArgs.launch, backend.name);
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
        indexPath,
        settings.handoff.pickerShortcut,
      );
      if (result.kind !== "insert-session-token") {
        return;
      }

      ctx.ui.pasteToEditor(`${SESSION_TOKEN_PREFIX}${result.sessionId}`);
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (splitBackend?.identifyTerminalId && ctx) {
      identifiedGhosttyTerminalId =
        (await splitBackend.identifyTerminalId(ctx.cwd)) ?? identifiedGhosttyTerminalId;
    }

    return {
      systemPrompt:
        event.systemPrompt +
        "\n\nWhen the user references @session:<uuid>, treat it as a session token. If you call session_ask, pass only the UUID value, not the @session: prefix.",
    };
  });

  return {
    async onSessionStart(_event, ctx) {
      modelSnapshot = ctx.modelRegistry.getAvailable();
      registerHandoffTool(
        modelSnapshot,
        createHandoffLaunchTargets({
          pi,
          splitBackend,
          copyDeferredToClipboard: settings.handoff.deferred.copyToClipboard,
          additionalTargets: deps.getLaunchTargets?.() ?? [],
        }),
      );

      await consumePendingHandoffBootstrap(pi, ctx, deps.getModelRuntime, pi.getThinkingLevel());
    },
  };
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
        await ctx.sendMessage(buildHandoffKickoffMessage(kickoff), {
          triggerTurn: true,
        });
      } catch (error) {
        ctx.ui.notify(formatHandoffError(error), "error");
      }
    })();
  });
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}
