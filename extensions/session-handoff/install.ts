import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { IndexHandle, SessionLifecycle } from "../shared/composition.ts";
import type { ModelRuntimeProvider } from "../shared/model-runtime.ts";
import { isTuiMode } from "../shared/pi-mode.ts";
import type { SessionSettings } from "../shared/settings.ts";
import { THINKING_LEVELS } from "../shared/thinking-levels.ts";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";
import { type HandoffBoardServices, openHandoffBoard } from "./board.ts";
import { consumePendingHandoffBootstrap } from "./bootstrap.ts";
import { HANDOFF_KICKOFF_CUSTOM_TYPE, renderHandoffKickoffMessage } from "./kickoff.ts";
import type { ClipboardStatus } from "./launch/backend.ts";
import { resolveSplitLaunchBackend } from "./launch/resolution.ts";
import { createHandoffLaunchTargets } from "./launch-options.ts";
import type { HandoffLaunchTarget } from "./launch-target.ts";
import { openSessionReferencePicker } from "./picker.ts";
import { SESSION_TOKEN_PREFIX } from "./query.ts";
import {
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
import { formatHandoffError } from "./ui.ts";

interface HandoffToolRendererState {
  callComponent?: HandoffToolComponent | undefined;
}

export function installHandoff(
  pi: ExtensionAPI,
  deps: {
    settings: SessionSettings;
    index: IndexHandle;
    getModelRuntime: ModelRuntimeProvider;
    getLaunchTargets?: (() => readonly HandoffLaunchTarget[]) | undefined;
    board: HandoffBoardServices;
  },
): SessionLifecycle {
  const { settings } = deps;
  const indexPath = deps.index.path;
  let identifiedGhosttyTerminalId: string | undefined;
  const clipboardStatusBySessionId = new Map<string, ClipboardStatus>();
  const splitBackend = resolveSplitLaunchBackend(pi, {
    getTerminalId: () => identifiedGhosttyTerminalId,
  });

  pi.registerMessageRenderer(HANDOFF_KICKOFF_CUSTOM_TYPE, renderHandoffKickoffMessage);
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
    description: "Open the handoff board",
    handler: async (args, ctx): Promise<void> => {
      if (!isTuiMode(ctx)) {
        ctx.ui.notify("handoff requires interactive mode", "error");
        return;
      }
      if (args.trim()) {
        ctx.ui.notify("/handoff does not accept arguments.", "error");
        return;
      }

      try {
        await openHandoffBoard(ctx, deps.board);
      } catch (error) {
        ctx.ui.notify(formatHandoffError(error), "error");
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
      registerHandoffTool(
        ctx.modelRegistry.getAvailable(),
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

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}
