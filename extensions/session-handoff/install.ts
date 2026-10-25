import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { IndexHandle, SessionLifecycle } from "../shared/composition.ts";
import type { HerdrSession } from "../shared/herdr.ts";
import type { ModelRuntimeProvider } from "../shared/model-runtime.ts";
import { isTuiMode } from "../shared/pi-mode.ts";
import type { SessionSettings } from "../shared/settings.ts";
import { THINKING_LEVELS } from "../shared/thinking-levels.ts";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";
import {
  type AgentProfileCatalog,
  EMPTY_AGENT_PROFILE_CATALOG,
  loadAgentProfiles,
} from "./agent-profiles.ts";
import { type HandoffBoardServices, openHandoffBoard } from "./board.ts";
import { consumePendingHandoffBootstrap } from "./bootstrap.ts";
import { renderHandoffBootstrapFailedEntry } from "./bootstrap-failed-renderer.ts";
import { HANDOFF_KICKOFF_CUSTOM_TYPE, renderHandoffKickoffMessage } from "./kickoff.ts";
import type { ClipboardStatus } from "./launch/backend.ts";
import { resolveSplitLaunchBackend, type SplitLaunchBackend } from "./launch/resolution.ts";
import { createHandoffLaunchTargets } from "./launch-options.ts";
import type { HandoffLaunchTarget } from "./launch-target.ts";
import { HANDOFF_BOOTSTRAP_FAILED_CUSTOM_TYPE } from "./metadata.ts";
import { openSessionReferencePicker } from "./picker.ts";
import { SESSION_TOKEN_PREFIX } from "./query.ts";
import { type HandoffRoster, resolveHandoffRoster } from "./roster.ts";
import { executeSessionHandoffTool, MAX_HANDOFF_TITLE_LENGTH } from "./tool.ts";
import { HANDOFF_TOOL_DETAILS_SCHEMA } from "./tool-contract.ts";
import { HandoffToolComponent } from "./tool-renderer.ts";
import {
  buildHandoffLaunchSchema,
  buildHandoffPromptGuidelines,
  offersSubagentLaunch,
} from "./tool-schema.ts";
import { buildHandoffToolView } from "./tool-view-model.ts";
import { formatHandoffError } from "./ui.ts";

const SESSION_TOKEN_PROMPT_SECTION = "pi_sessions_session_token";
const SESSION_TOKEN_PROMPT =
  "When the user references @session:<uuid>, treat it as a session token. If you call session_ask, pass only the UUID value, not the @session: prefix.";

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
    claimsPeers: () => boolean;
    getHerdr(): HerdrSession | undefined;
    board: HandoffBoardServices;
  },
): SessionLifecycle {
  const { settings } = deps;
  const indexPath = deps.index.path;
  let identifiedGhosttyTerminalId: string | undefined;
  const clipboardStatusBySessionId = new Map<string, ClipboardStatus>();
  let splitBackend: SplitLaunchBackend | undefined;

  pi.registerMessageRenderer(HANDOFF_KICKOFF_CUSTOM_TYPE, renderHandoffKickoffMessage);
  pi.registerEntryRenderer(HANDOFF_BOOTSTRAP_FAILED_CUSTOM_TYPE, renderHandoffBootstrapFailedEntry);
  function registerHandoffTool(
    models: readonly Model<Api>[],
    launchTargets: readonly HandoffLaunchTarget[],
    roster: HandoffRoster | undefined,
    agentProfiles: AgentProfileCatalog,
    name: "session_handoff" | "subagent_launch",
  ): void {
    const offersSubagent = offersSubagentLaunch(launchTargets);
    const offersAgents = name === "subagent_launch" && agentProfiles.profiles.length > 0;
    pi.registerTool({
      name,
      label: "Session Handoff",
      description: "Start a new Pi session with a self-contained task.",
      // Nested calls write no toolResult entry, so the board would never see the launch receipt.
      exposure: "model-only",
      promptSnippet: offersSubagent
        ? "Delegate bounded work to a background subagent"
        : "Hand off context to another Pi session",
      promptGuidelines: buildHandoffPromptGuidelines(
        launchTargets,
        models,
        roster,
        offersAgents ? agentProfiles.profiles : [],
      ),
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
        ...(name === "session_handoff" ? { launch: buildHandoffLaunchSchema(launchTargets) } : {}),
        cwd: Type.Optional(
          Type.String({
            description: "Optional target working directory (defaults to current).",
          }),
        ),
        requestResponse: Type.Boolean({
          description:
            "Whether the child session should report completion/results of its task back to this session.",
        }),
        provider: Type.Optional(
          Type.String({
            description: "Model provider for the child session.",
          }),
        ),
        model: Type.Optional(
          Type.String({
            description: "Model id for the child session.",
          }),
        ),
        thinkingLevel: Type.Optional(
          Type.Union(
            THINKING_LEVELS.map((level) => Type.Literal(level)),
            {
              description: offersSubagent
                ? "Thinking level for the child session. For launches other than subagent, override only when the user requests it."
                : "Thinking level for the child session. Override only when the user requests it.",
            },
          ),
        ),
        ...(offersAgents
          ? {
              agent: Type.Optional(
                Type.String({
                  description:
                    "Agent profile to run the subagent as. The profile adds instructions to the subagent's system prompt and may set its model and thinking level; explicit provider/model and thinkingLevel take precedence.",
                }),
              ),
            }
          : {}),
      }),
      renderCall(args, theme, context) {
        const state = context.state as HandoffToolRendererState;
        const component = state.callComponent ?? new HandoffToolComponent(theme);
        state.callComponent = component;
        component.update(buildHandoffToolView(args, undefined, name), context.expanded);
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
          buildHandoffToolView(context.args, details, name),
          options.expanded,
          clipboardStatusBySessionId.get(details.sessionId),
        );
        return new Text("", 0, 0);
      },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (name === "session_handoff" && deps.claimsPeers())
          throw new Error("Peer tools belong to the current host.");
        const launch = name === "subagent_launch" ? "subagent" : params.launch;
        if (typeof launch !== "string") throw new Error("session_handoff requires launch.");
        if (name === "subagent_launch" && !deps.getLaunchTargets?.().length)
          throw new Error("Subagent launch is unavailable.");
        const { agent, ...rest } = params;
        if (agent !== undefined && typeof agent !== "string")
          throw new Error("agent must name an agent profile.");
        const modelRuntime = deps.getModelRuntime(ctx.modelRegistry);
        return executeSessionHandoffTool(
          pi,
          { ...rest, launch, ...(agent === undefined ? {} : { agent }) },
          ctx,
          modelRuntime,
          launchTargets,
          roster,
          agentProfiles,
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
    if (!deps.claimsPeers() && splitBackend?.identifyTerminalId && ctx) {
      identifiedGhosttyTerminalId =
        (await splitBackend.identifyTerminalId(ctx.cwd)) ?? identifiedGhosttyTerminalId;
    }

    event.systemPromptOptions.sections[SESSION_TOKEN_PROMPT_SECTION] = SESSION_TOKEN_PROMPT;
  });

  return {
    async onSessionStart(_event, ctx) {
      splitBackend = resolveSplitLaunchBackend(pi, {
        getTerminalId: () => identifiedGhosttyTerminalId,
        herdr: deps.getHerdr(),
      });
      const models = ctx.modelRegistry.getAvailable();
      const roster = resolveHandoffRoster({
        models,
        patterns: settings.handoff.roster,
        scopedModels: ctx.scopedModels,
      });
      const subagentTargets = deps.getLaunchTargets?.() ?? [];
      const agentProfiles = subagentTargets.length
        ? loadAgentProfiles(settings.subagents.agentsDir)
        : EMPTY_AGENT_PROFILE_CATALOG;
      if (!deps.claimsPeers?.()) {
        registerHandoffTool(
          models,
          createHandoffLaunchTargets({
            pi,
            splitBackend,
            deferred: settings.handoff.deferred,
            additionalTargets: [],
          }),
          roster,
          EMPTY_AGENT_PROFILE_CATALOG,
          "session_handoff",
        );
        pi.setActiveTools([...new Set([...pi.getActiveTools(), "session_handoff"])]);
      } else {
        pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "session_handoff"));
      }
      if (subagentTargets.length) {
        registerHandoffTool(models, subagentTargets, roster, agentProfiles, "subagent_launch");
        pi.setActiveTools([...new Set([...pi.getActiveTools(), "subagent_launch"])]);
      } else {
        pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "subagent_launch"));
      }

      await consumePendingHandoffBootstrap(
        pi,
        ctx,
        deps.getModelRuntime,
        pi.getThinkingLevel(),
        settings.handoff,
      );
    },
  };
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}
