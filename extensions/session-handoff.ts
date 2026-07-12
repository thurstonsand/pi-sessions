import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getHandoffModelCompletions } from "./session-handoff/completions.ts";
import {
  generateHandoffDraft,
  generateHandoffDraftFromSessionManager,
  type HandoffDraftResult,
} from "./session-handoff/extract.ts";
import { createDetachedLaunchBackend } from "./session-handoff/launch/detached.ts";
import {
  createGhosttyLaunchBackend,
  getFocusedGhosttyTerminalId,
  type HandoffSplitDirection,
  isGhosttyHandoffAvailable,
  validateSplitHandoffPrerequisites,
} from "./session-handoff/launch/ghostty.ts";
import {
  type ChildGeneratedHandoffBootstrap,
  createChildGeneratedHandoffBootstrap,
  createHandoffBootstrap,
  createHandoffSessionMetadata,
  getHandoffMetadataFromEntries,
  HANDOFF_BOOTSTRAP_ENV,
  HANDOFF_METADATA_CUSTOM_TYPE,
  HANDOFF_STALE_SESSION_MESSAGE,
  hasUserMessages,
  isChildGeneratedHandoffBootstrap,
  parseHandoffBootstrap,
} from "./session-handoff/metadata.ts";
import {
  formatModelArgument,
  formatModelList,
  resolveModelOverride,
} from "./session-handoff/model.ts";
import { openSessionReferencePicker } from "./session-handoff/picker.ts";
import { SESSION_TOKEN_PREFIX } from "./session-handoff/query.ts";
import {
  renderStrongModal,
  reviewHandoffDraft,
  reviewHandoffDraftForSend,
} from "./session-handoff/review.ts";
import { prepareHandoffLaunch } from "./session-handoff/spawn.ts";
import { isTuiMode } from "./shared/pi-mode.ts";
import { loadSettings } from "./shared/settings.ts";

const HANDOFF_USAGE =
  "Usage: /handoff [--left|--right|--up|--down|--detached] <goal for new thread>";
const TOOL_HANDOFF_PROVISIONAL_TITLE = "Session handoff";
const NO_IDENTIFIED_TERMINAL_MESSAGE =
  "No Ghostty source terminal identified. Run /handoff --identify from the intended source pane.";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const LAUNCH_DIRECTIONS = ["left", "right", "up", "down"] as const;
const DETACHED_LAUNCH = "detached" as const;

type HandoffLaunchTarget = HandoffSplitDirection | typeof DETACHED_LAUNCH;

function handoffLaunchSchema(ghosttyAvailable: boolean) {
  const values: HandoffLaunchTarget[] = ghosttyAvailable
    ? [...LAUNCH_DIRECTIONS, DETACHED_LAUNCH]
    : [DETACHED_LAUNCH];
  const description = ghosttyAvailable
    ? "Where to launch the child session. 'detached' creates the session and returns the resume command without opening anything; direction values open a Ghostty split. If the user does not make it clear which launch target to use, ask for clarification."
    : "Where to launch the child session. 'detached' creates the session and returns the resume command without opening anything.";
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
    : `${base} Available models: ${formatModelList(models)}.`;
}

interface HandoffToolParams {
  goal: string;
  launch: HandoffLaunchTarget;
  cwd?: string | undefined;
  requestResponse?: boolean | undefined;
  model?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
}

interface HandoffToolDetails {
  sessionId?: string | undefined;
  title?: string | undefined;
  launch?: HandoffLaunchTarget | undefined;
  cwd?: string | undefined;
  resumeCommand?: string | undefined;
  degradedFrom?: HandoffSplitDirection | undefined;
}

interface HandoffPromptContext {
  ui: ExtensionUIContext;
  sendUserMessage(content: string): Promise<void>;
}

export default function sessionHandoffExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();
  let identifiedGhosttyTerminalId: string | undefined;
  let modelSnapshot: Model<Api>[] = [];

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
      renderResult(result, _options, theme, context) {
        const text = getFirstText(result);
        if (context.isError) {
          return new Text(theme.fg("error", text), 0, 0);
        }

        const details = result.details as HandoffToolDetails | undefined;
        if (!details?.sessionId || !details.launch || !details.cwd) {
          return new Text(text, 0, 0);
        }

        if (details.launch === DETACHED_LAUNCH) {
          const resume = details.resumeCommand
            ? `\nStart with: ${theme.fg("dim", details.resumeCommand)}`
            : "";
          return new Text(
            `Created detached handoff session ${theme.bold(details.sessionId)} in ${theme.fg("dim", details.cwd)}.${resume}`,
            0,
            0,
          );
        }

        const degraded = details.degradedFrom
          ? ` (requested ${details.degradedFrom}; Ghostty unavailable)`
          : "";
        return new Text(
          `Started handoff session ${theme.bold(details.sessionId)} (${details.launch})${degraded} in ${theme.fg("dim", details.cwd)}.`,
          0,
          0,
        );
      },
      async execute(_toolCallId, params: HandoffToolParams, _signal, _onUpdate, ctx) {
        return executeSessionHandoffTool(
          pi,
          params,
          ctx,
          identifiedGhosttyTerminalId,
          settings.handoff.detached.copyToClipboard,
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

      const sessionContext = buildSessionContext(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getLeafId(),
      );
      if (sessionContext.messages.length === 0) {
        ctx.ui.notify("No conversation to hand off", "error");
        return;
      }

      let resolvedOverride:
        | { model: Model<Api>; thinkingLevel?: ThinkingLevel | undefined }
        | undefined;
      if (parsedArgs.model) {
        try {
          resolvedOverride = {
            model: resolveModelOverride(ctx.modelRegistry.getAvailable(), parsedArgs.model),
            thinkingLevel: parsedArgs.thinkingLevel,
          };
        } catch (error) {
          ctx.ui.notify(formatHandoffError(error), "error");
          return;
        }
      }

      if (parsedArgs.launch && parsedArgs.launch !== DETACHED_LAUNCH) {
        const preflightError = await validateSplitHandoffPrerequisites(ctx);
        if (preflightError) {
          ctx.ui.notify(preflightError, "error");
          return;
        }
      }

      let generatedDraft: HandoffDraftResult | undefined;
      try {
        generatedDraft = await runWithLoader(
          ctx,
          "Generating handoff draft...",
          async (signal: AbortSignal) =>
            generateHandoffDraft(ctx, parsedArgs.goal, pi.getThinkingLevel(), signal),
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
      const model = formatModelArgument(
        resolvedOverride?.model ?? ctx.model,
        resolvedOverride?.thinkingLevel ?? pi.getThinkingLevel(),
      );
      if (parsedArgs.launch) {
        const prepared = prepareHandoffLaunch({
          cwd: ctx.cwd,
          sessionDir: ctx.sessionManager.getSessionDir(),
          parentSessionFile,
          title: handoffMetadata.title,
          model,
          buildBootstrap: (sessionId) => createHandoffBootstrap(sessionId, handoffMetadata),
        });

        if (parsedArgs.launch === DETACHED_LAUNCH) {
          await createDetachedLaunchBackend({
            copyToClipboard: settings.handoff.detached.copyToClipboard,
          }).launch({
            cwd: ctx.cwd,
            title: handoffMetadata.title,
            resumeCommand: prepared.resumeCommand,
          });

          ctx.ui.notify(
            settings.handoff.detached.copyToClipboard
              ? "Detached handoff created. Resume command copied to clipboard."
              : `Detached handoff created. Resume with: ${prepared.resumeCommand}`,
            "info",
          );
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

        ctx.ui.notify(`Handoff started in a new pane (${parsedArgs.launch}).`, "info");
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
          startHandoffPromptAfterSessionRender(nextCtx, approvedDraft);
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

    const encodedBootstrap = process.env[HANDOFF_BOOTSTRAP_ENV];
    if (!encodedBootstrap) {
      return;
    }

    const bootstrap = parseHandoffBootstrap(encodedBootstrap);
    if (!bootstrap) {
      delete process.env[HANDOFF_BOOTSTRAP_ENV];
      return;
    }

    if (bootstrap.sessionId !== ctx.sessionManager.getSessionId()) {
      return;
    }

    try {
      if (isChildGeneratedHandoffBootstrap(bootstrap)) {
        await startChildGeneratedHandoff(pi, ctx, bootstrap, pi.getThinkingLevel());
        return;
      }

      const entries = ctx.sessionManager.getEntries();
      if (hasUserMessages(entries)) {
        if (ctx.hasUI) {
          ctx.ui.notify(HANDOFF_STALE_SESSION_MESSAGE, "error");
        }
        return;
      }

      if (!getHandoffMetadataFromEntries(entries)) {
        pi.appendEntry(
          HANDOFF_METADATA_CUSTOM_TYPE,
          createHandoffSessionMetadata(
            bootstrap.goal,
            bootstrap.nextTask,
            bootstrap.initialPrompt,
            bootstrap.title,
          ),
        );
      }

      if (!ctx.sessionManager.getSessionName()) {
        pi.setSessionName(bootstrap.title);
      }

      pi.sendUserMessage(bootstrap.initialPrompt);
    } finally {
      delete process.env[HANDOFF_BOOTSTRAP_ENV];
    }
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

async function executeSessionHandoffTool(
  pi: ExtensionAPI,
  params: HandoffToolParams,
  ctx: ExtensionContext,
  terminalId: string | undefined,
  copyToClipboardSetting: boolean,
) {
  const goal = params.goal.trim();
  if (!goal) {
    throw new Error("session_handoff requires a goal.");
  }

  if (!ctx.model) {
    throw new Error("No model selected.");
  }

  const direction = params.launch === DETACHED_LAUNCH ? undefined : params.launch;
  const useGhostty = direction !== undefined && isGhosttyHandoffAvailable();
  const degradedFrom = direction !== undefined && !useGhostty ? direction : undefined;

  if (useGhostty && !terminalId) {
    throw new Error(NO_IDENTIFIED_TERMINAL_MESSAGE);
  }

  const targetCwd = resolveHandoffCwd(ctx.cwd, params.cwd);
  if (targetCwd.error) {
    throw new Error(targetCwd.message);
  }

  const parentSessionFile = ctx.sessionManager.getSessionFile();
  if (!parentSessionFile) {
    throw new Error("Handoff requires a persisted current session.");
  }

  const invocationLeafId = ctx.sessionManager.getLeafId();
  const sourceLeafId = invocationLeafId
    ? ctx.sessionManager.getEntry(invocationLeafId)?.parentId
    : undefined;
  if (!sourceLeafId) {
    throw new Error("No conversation to hand off.");
  }

  const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), sourceLeafId);
  if (sessionContext.messages.length === 0) {
    throw new Error("No conversation to hand off.");
  }

  const requestResponse = params.requestResponse ?? false;
  const overrideModel = params.model
    ? resolveModelOverride(ctx.modelRegistry.getAvailable(), params.model)
    : ctx.model;
  const model = formatModelArgument(overrideModel, params.thinkingLevel ?? pi.getThinkingLevel());
  const prepared = prepareHandoffLaunch({
    cwd: targetCwd.path,
    sessionDir: ctx.sessionManager.getSessionDir(),
    parentSessionFile,
    title: TOOL_HANDOFF_PROVISIONAL_TITLE,
    model,
    buildBootstrap: (sessionId) =>
      createChildGeneratedHandoffBootstrap({
        sessionId,
        goal,
        title: TOOL_HANDOFF_PROVISIONAL_TITLE,
        parentSessionFile,
        sourceLeafId,
        requestResponse,
      }),
  });
  const backend =
    useGhostty && direction !== undefined
      ? createGhosttyLaunchBackend(pi, { direction, terminalId })
      : createDetachedLaunchBackend({
          copyToClipboard: copyToClipboardSetting,
        });
  const outcome = await backend.launch({
    cwd: targetCwd.path,
    title: TOOL_HANDOFF_PROVISIONAL_TITLE,
    resumeCommand: prepared.resumeCommand,
  });

  if (!outcome.success) {
    throw new Error(
      `${outcome.error} Created handoff session ${prepared.sessionId}; start it manually with: ${prepared.resumeCommand}`,
    );
  }

  const effectiveLaunch: HandoffLaunchTarget =
    useGhostty && direction !== undefined ? direction : DETACHED_LAUNCH;
  const details: HandoffToolDetails = {
    sessionId: prepared.sessionId,
    title: TOOL_HANDOFF_PROVISIONAL_TITLE,
    launch: effectiveLaunch,
    cwd: targetCwd.path,
    ...(effectiveLaunch === DETACHED_LAUNCH ? { resumeCommand: prepared.resumeCommand } : {}),
    ...(degradedFrom ? { degradedFrom } : {}),
  };

  return {
    content: [
      {
        type: "text" as const,
        text: formatHandoffToolResultForModel(details, requestResponse),
      },
    ],
    details,
  };
}

async function startChildGeneratedHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  bootstrap: ChildGeneratedHandoffBootstrap,
  thinkingLevel: ThinkingLevel | undefined,
): Promise<void> {
  const entries = ctx.sessionManager.getEntries();
  if (hasUserMessages(entries)) {
    if (ctx.hasUI) {
      ctx.ui.notify(HANDOFF_STALE_SESSION_MESSAGE, "error");
    }
    return;
  }

  if (!ctx.hasUI) {
    return;
  }

  try {
    const sourceSessionManager = SessionManager.open(bootstrap.parentSessionFile);
    const generatedDraft = await runWithLoader(
      ctx,
      "Generating handoff draft...",
      async (signal: AbortSignal) =>
        generateHandoffDraftFromSessionManager(
          ctx,
          sourceSessionManager,
          bootstrap.sourceLeafId,
          bootstrap.goal,
          thinkingLevel,
          signal,
          bootstrap.requestResponse ?? false,
        ),
    );
    if (!generatedDraft) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const review = await reviewHandoffDraftForSend(ctx.ui, generatedDraft.draft);
    if (review.action === "prefill") {
      ctx.ui.setEditorText(review.prompt);
      ctx.ui.notify("Handoff prompt ready in editor.", "info");
      return;
    }

    if (review.action === "cancel") {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const metadata = createHandoffSessionMetadata(
      bootstrap.goal,
      generatedDraft.context.nextTask,
      review.prompt,
      generatedDraft.context.title,
    );
    if (!getHandoffMetadataFromEntries(ctx.sessionManager.getEntries())) {
      pi.appendEntry(HANDOFF_METADATA_CUSTOM_TYPE, metadata);
    }
    pi.setSessionName(metadata.title);
    pi.sendUserMessage(review.prompt);
  } catch (error) {
    ctx.ui.notify(formatHandoffError(error), "error");
  }
}

function formatHandoffToolResultForModel(
  details: HandoffToolDetails,
  requestResponse: boolean,
): string {
  return JSON.stringify({ ...details, requestResponse }, null, 2);
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

function resolveHandoffCwd(
  currentCwd: string,
  requestedCwd: string | undefined,
): { path: string; error?: undefined } | { error: true; message: string } {
  const rawPath = requestedCwd?.trim();
  const resolvedPath = rawPath ? resolveRequestedPath(currentCwd, rawPath) : currentCwd;

  if (!existsSync(resolvedPath)) {
    return {
      error: true,
      message: `Handoff cwd does not exist: ${resolvedPath}`,
    };
  }

  if (!statSync(resolvedPath).isDirectory()) {
    return {
      error: true,
      message: `Handoff cwd is not a directory: ${resolvedPath}`,
    };
  }

  return { path: resolvedPath };
}

function resolveRequestedPath(currentCwd: string, requestedPath: string): string {
  if (requestedPath === "~") {
    return homedir();
  }

  if (requestedPath.startsWith("~/")) {
    return resolve(homedir(), requestedPath.slice(2));
  }

  if (isAbsolute(requestedPath)) {
    return requestedPath;
  }

  return resolve(currentCwd, requestedPath);
}

async function runWithLoader<T>(
  ctx: { ui: ExtensionUIContext },
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

async function applyHandoffModelOverride(
  pi: ExtensionAPI,
  ctx: { ui: ExtensionUIContext },
  override: { model: Model<Api>; thinkingLevel?: ThinkingLevel | undefined } | undefined,
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
  approvedDraft: string,
): void {
  // ctx.newSession() renders the replacement session only after withSession returns.
  setImmediate(() => {
    void (async () => {
      try {
        await ctx.sendUserMessage(approvedDraft);
        ctx.ui.notify("Handoff started in a new session.", "info");
      } catch (error) {
        ctx.ui.notify(formatHandoffError(error), "error");
      }
    })();
  });
}

function formatHandoffError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "Handoff generation failed.";
}

function parseHandoffCommandArgs(args: string):
  | { kind: "identify" }
  | {
      kind: "ok";
      goal: string;
      launch?: HandoffLaunchTarget | undefined;
      model?: string | undefined;
      thinkingLevel?: ThinkingLevel | undefined;
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
    ["--detached", DETACHED_LAUNCH],
  ]);

  let launch: HandoffLaunchTarget | undefined;
  let model: string | undefined;
  let thinkingLevel: ThinkingLevel | undefined;
  const goalTokens: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;

    if (token === "--model") {
      const value = tokens[i + 1];
      if (!value) {
        return { kind: "error", message: HANDOFF_USAGE };
      }

      const parsed = splitModelReference(value);
      model = parsed.reference;
      thinkingLevel = parsed.thinkingLevel;
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
        message: "Use only one launch target: --left, --right, --up, --down, or --detached.",
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
    thinkingLevel,
  };
}

function splitModelReference(value: string): {
  reference: string;
  thinkingLevel?: ThinkingLevel | undefined;
} {
  const colon = value.lastIndexOf(":");
  if (colon > 0) {
    const suffix = value.slice(colon + 1);
    if ((THINKING_LEVELS as readonly string[]).includes(suffix)) {
      return {
        reference: value.slice(0, colon),
        thinkingLevel: suffix as ThinkingLevel,
      };
    }
  }

  return { reference: value };
}
