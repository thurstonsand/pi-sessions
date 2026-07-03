import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  generateHandoffDraft,
  generateHandoffDraftFromSessionManager,
  type HandoffDraftResult,
} from "./session-handoff/extract.ts";
import {
  type ChildGeneratedHandoffBootstrap,
  createChildGeneratedHandoffBootstrap,
  createHandoffBootstrap,
  createHandoffSessionMetadata,
  encodeHandoffBootstrap,
  getHandoffMetadataFromEntries,
  HANDOFF_BOOTSTRAP_ENV,
  HANDOFF_METADATA_CUSTOM_TYPE,
  HANDOFF_STALE_SESSION_MESSAGE,
  hasUserMessages,
  isChildGeneratedHandoffBootstrap,
  parseHandoffBootstrap,
} from "./session-handoff/metadata.ts";
import { openSessionReferencePicker } from "./session-handoff/picker.ts";
import { SESSION_TOKEN_PREFIX } from "./session-handoff/query.ts";
import {
  renderStrongModal,
  reviewHandoffDraft,
  reviewHandoffDraftForSend,
} from "./session-handoff/review.ts";
import {
  buildPiResumeCommand,
  createHandoffSession,
  getFocusedGhosttyTerminalId,
  type HandoffSplitDirection,
  isGhosttyHandoffAvailable,
  launchSplitHandoffSession,
  validateSplitHandoffPrerequisites,
} from "./session-handoff/spawn.ts";
import { isTuiMode } from "./shared/pi-mode.ts";
import { loadSettings } from "./shared/settings.ts";

const HANDOFF_USAGE = "Usage: /handoff [--left|--right|--up|--down] <goal for new thread>";
const TOOL_HANDOFF_PROVISIONAL_TITLE = "Session handoff";
const NO_IDENTIFIED_TERMINAL_MESSAGE =
  "No Ghostty source terminal identified. Run /handoff --identify from the intended source pane.";

interface HandoffToolParams {
  goal: string;
  splitDirection: HandoffSplitDirection;
  cwd?: string | undefined;
  requestResponse?: boolean | undefined;
}

interface HandoffToolDetails {
  sessionId?: string | undefined;
  title?: string | undefined;
  splitDirection?: HandoffSplitDirection | undefined;
  cwd?: string | undefined;
}

interface HandoffPromptContext {
  ui: ExtensionUIContext;
  sendUserMessage(content: string): Promise<void>;
}

export default function sessionHandoffExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();
  let identifiedGhosttyTerminalId: string | undefined;

  if (isGhosttyHandoffAvailable()) {
    pi.registerTool({
      name: "session_handoff",
      label: "Session Handoff",
      description:
        "Start a new background Pi session with directed instructions based on current work. The current session continues after launch.",
      promptSnippet:
        "Start a background pi session in a terminal split based on the current session",
      promptGuidelines: [
        "Use session_handoff only when it is clear the work should be forked to a new context.",
        "Prefer using session_handoff by direction of the user, not as an unsolicited default.",
        "The goal should capture enough detail to encompass the ask and include any directions the next sessions should consider.",
        "Only capable of a background handoff; to replace the current session, tell the user to run /handoff instead.",
      ],
      executionMode: "sequential",
      parameters: Type.Object({
        goal: Type.String({
          description:
            "Goal for the new session, including enough detail to capture the user's ask and any directions the next prompt should consider.",
        }),
        splitDirection: Type.Union(
          [Type.Literal("left"), Type.Literal("right"), Type.Literal("up"), Type.Literal("down")],
          {
            description:
              "Direction to split the Ghostty terminal. Must be explicitly provided by the user.",
          },
        ),
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
      }),
      renderResult(result, _options, theme, context) {
        const text = getFirstText(result);
        if (context.isError) {
          return new Text(theme.fg("error", text), 0, 0);
        }

        const details = result.details as HandoffToolDetails | undefined;
        if (!details?.sessionId || !details.splitDirection || !details.cwd) {
          return new Text(text, 0, 0);
        }

        return new Text(
          `Started handoff session ${theme.bold(details.sessionId)} (${details.splitDirection}) in ${theme.fg("dim", details.cwd)}.`,
          0,
          0,
        );
      },
      async execute(_toolCallId, params: HandoffToolParams, _signal, _onUpdate, ctx) {
        return executeSessionHandoffTool(pi, params, ctx, identifiedGhosttyTerminalId);
      },
    });
  }

  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session",
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

      if (parsedArgs.splitDirection) {
        const preflightError = await validateSplitHandoffPrerequisites(pi, ctx);
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
      if (parsedArgs.splitDirection) {
        const createdSession = createHandoffSession({
          cwd: ctx.cwd,
          sessionDir: ctx.sessionManager.getSessionDir(),
          parentSessionFile,
          title: handoffMetadata.title,
        });
        const bootstrapValue = encodeHandoffBootstrap(
          createHandoffBootstrap(createdSession.sessionId, handoffMetadata),
        );
        let launchResult = await launchSplitHandoffSession(pi, {
          cwd: ctx.cwd,
          sessionDir: ctx.sessionManager.getSessionDir(),
          direction: parsedArgs.splitDirection,
          sessionId: createdSession.sessionId,
          bootstrapValue,
          title: handoffMetadata.title,
          terminalId: identifiedGhosttyTerminalId,
        });
        if (!launchResult.success && identifiedGhosttyTerminalId) {
          launchResult = await launchSplitHandoffSession(pi, {
            cwd: ctx.cwd,
            sessionDir: ctx.sessionManager.getSessionDir(),
            direction: parsedArgs.splitDirection,
            sessionId: createdSession.sessionId,
            bootstrapValue,
            title: handoffMetadata.title,
          });
        }

        if (!launchResult.success) {
          ctx.ui.notify(
            `${launchResult.error} Created handoff session ${createdSession.sessionId}; start it manually with: ${buildPiResumeCommand(ctx.sessionManager.getSessionDir(), createdSession.sessionId, bootstrapValue, handoffMetadata.title)}`,
            "error",
          );
          return;
        }

        ctx.ui.notify(`Handoff started in a new pane (${parsedArgs.splitDirection}).`, "info");
        return;
      }

      const switchResult = await ctx.newSession({
        parentSession: parentSessionFile,
        setup: async (sessionManager) => {
          sessionManager.appendSessionInfo(handoffMetadata.title);
          sessionManager.appendCustomEntry(HANDOFF_METADATA_CUSTOM_TYPE, handoffMetadata);
        },
        withSession: async (nextCtx) => {
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
) {
  const goal = params.goal.trim();
  if (!goal) {
    throw new Error("session_handoff requires a goal.");
  }

  if (!ctx.model) {
    throw new Error("No model selected.");
  }

  const preflightError = await validateSplitHandoffPrerequisites(pi, ctx);
  if (preflightError) {
    throw new Error(preflightError);
  }

  if (!terminalId) {
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

  const sessionContext = buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
  );
  if (sessionContext.messages.length === 0) {
    throw new Error("No conversation to hand off.");
  }

  const requestResponse = params.requestResponse ?? false;
  const createdSession = createHandoffSession({
    cwd: targetCwd.path,
    sessionDir: ctx.sessionManager.getSessionDir(),
    parentSessionFile,
    title: TOOL_HANDOFF_PROVISIONAL_TITLE,
  });
  const bootstrapValue = encodeHandoffBootstrap(
    createChildGeneratedHandoffBootstrap({
      sessionId: createdSession.sessionId,
      goal,
      title: TOOL_HANDOFF_PROVISIONAL_TITLE,
      parentSessionFile,
      requestResponse,
    }),
  );
  const model = formatModelArgument(ctx.model, pi.getThinkingLevel());
  const launchResult = await launchSplitHandoffSession(pi, {
    cwd: targetCwd.path,
    sessionDir: ctx.sessionManager.getSessionDir(),
    direction: params.splitDirection,
    sessionId: createdSession.sessionId,
    bootstrapValue,
    title: TOOL_HANDOFF_PROVISIONAL_TITLE,
    terminalId,
    restoreFocus: true,
    model,
  });

  if (!launchResult.success) {
    throw new Error(
      `${launchResult.error} Created handoff session ${createdSession.sessionId}; start it manually with: ${buildPiResumeCommand(
        ctx.sessionManager.getSessionDir(),
        createdSession.sessionId,
        bootstrapValue,
        TOOL_HANDOFF_PROVISIONAL_TITLE,
        model,
      )}`,
    );
  }

  const details: HandoffToolDetails = {
    sessionId: createdSession.sessionId,
    title: TOOL_HANDOFF_PROVISIONAL_TITLE,
    splitDirection: params.splitDirection,
    cwd: targetCwd.path,
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

function formatModelArgument(
  model: ExtensionContext["model"],
  thinkingLevel: ThinkingLevel | undefined,
): string | undefined {
  if (!model) {
    return undefined;
  }

  const base = `${model.provider}/${model.id}`;
  return thinkingLevel ? `${base}:${thinkingLevel}` : base;
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
      splitDirection?: HandoffSplitDirection | undefined;
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

  const directionFlags = new Map<string, HandoffSplitDirection>([
    ["--left", "left"],
    ["--right", "right"],
    ["--up", "up"],
    ["--down", "down"],
  ]);

  let splitDirection: HandoffSplitDirection | undefined;
  const goalTokens: string[] = [];

  for (const token of tokens) {
    const direction = directionFlags.get(token);
    if (!direction) {
      goalTokens.push(token);
      continue;
    }

    if (splitDirection) {
      return {
        kind: "error",
        message: "Use only one split flag: --left, --right, --up, or --down.",
      };
    }

    splitDirection = direction;
  }

  const goal = goalTokens.join(" ").trim();
  if (!goal) {
    return { kind: "error", message: HANDOFF_USAGE };
  }

  return {
    kind: "ok",
    goal,
    splitDirection,
  };
}
