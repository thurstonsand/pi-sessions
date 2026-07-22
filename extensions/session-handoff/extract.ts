import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRuntime,
  SessionContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildSessionContext,
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { freshenModel } from "../shared/model-runtime.ts";
import { getDefaultHandoffRunsDir } from "../shared/settings.ts";
import { parseTypeBoxValue } from "../shared/typebox.ts";

const MAX_HANDOFF_EXTRACTION_ATTEMPTS = 3;
const HANDOFF_EXTRACTION_RETRY_PROMPT =
  "You did not call create_handoff_context. Call it exactly once now with the completed briefing.";

const HANDOFF_SYSTEM_PROMPT = `You extract supporting context for a deliberate session handoff. You are preparing a briefing for a new destination session from a snapshot of its ongoing parent session.

The Handoff Goal is the authoritative and exclusive task of the destination session, and will be directly passed into that session. Do not rewrite, expand the scope of, or replace the goal.

The parent snapshot is reference material used only to provide evidence that supports that goal. Do not continue the parent conversation, respond to any questions in it, or carry forward parent tasks, unresolved work, instructions, or plans outside the goal. Only identify relevant context, files, constraints, and known decisions for the Handoff Goal.

The parent may be coordinating several parallel sessions. Do not include any references to those other sessions.`;

const HANDOFF_EXTRACTION_PARAMETERS = Type.Object({
  summary: Type.String({
    description:
      "Context from the parent task that is directly relevant to the Handoff Goal. Include only details that further support the goal.",
  }),
  relevantFiles: Type.Array(Type.String(), {
    description: "Relevant file paths.",
  }),
  openQuestions: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Unresolved questions that materially affect the destination task. Omit when there are none.",
    }),
  ),
});

type HandoffExtractionArgs = Static<typeof HANDOFF_EXTRACTION_PARAMETERS>;

export interface HandoffContext {
  summary: string;
  relevantFiles: string[];
  openQuestions: string[];
}

export interface HandoffDraftResult {
  draft: string;
  context: HandoffContext;
  sessionId: string;
  sessionPath?: string | undefined;
  debugSessionPath?: string | undefined;
}

/** Validate an anchored source branch and return its built context. Throws a user-facing Error otherwise. */
export function resolveHandoffSource(
  sessionManager: ExtensionContext["sessionManager"],
  sourceLeafId: string,
): SessionContext {
  if (!sessionManager.getEntry(sourceLeafId)) {
    throw new Error(`Handoff source snapshot entry ${sourceLeafId} was not found.`);
  }

  const sessionContext = buildSessionContext(sessionManager.getEntries(), sourceLeafId);
  if (sessionContext.messages.length === 0) {
    throw new Error("No conversation to hand off.");
  }

  return sessionContext;
}

export async function generateHandoffDraftFromSessionManager(
  ctx: ExtensionContext,
  modelRuntime: ModelRuntime,
  sourceSessionManager: ExtensionContext["sessionManager"],
  sourceLeafId: string,
  goal: string,
  thinkingLevel: ThinkingLevel | undefined,
  persistRuns: boolean,
  signal?: AbortSignal,
  requestResponse = false,
): Promise<HandoffDraftResult | undefined> {
  if (!ctx.model) {
    throw new Error("No model is available for handoff.");
  }

  const model = freshenModel(modelRuntime, ctx.model);
  const sessionContext = resolveHandoffSource(sourceSessionManager, sourceLeafId);

  const conversationText = serializeConversation(convertToLlm(sessionContext.messages));
  const handoffContext = await runHandoffExtractionAgent(
    ctx,
    modelRuntime,
    model,
    conversationText,
    goal,
    thinkingLevel,
    persistRuns,
    signal,
  );
  if (!handoffContext) {
    return undefined;
  }

  const sessionId = sourceSessionManager.getSessionId();
  const sessionPath = sourceSessionManager.getSessionFile();

  return {
    draft: assembleHandoffDraft(
      sessionId,
      sessionPath,
      handoffContext.context,
      goal,
      requestResponse,
    ),
    context: handoffContext.context,
    sessionId,
    sessionPath,
    ...(handoffContext.debugSessionPath
      ? { debugSessionPath: handoffContext.debugSessionPath }
      : {}),
  };
}

export function buildExtractionPrompt(conversationText: string, goal: string): string {
  return [
    "<conversation>",
    conversationText,
    "</conversation>",
    "",
    "<handoff-goal>",
    goal,
    "</handoff-goal>",
  ].join("\n");
}

async function runHandoffExtractionAgent(
  ctx: ExtensionContext,
  modelRuntime: ModelRuntime,
  model: Model<Api>,
  conversationText: string,
  goal: string,
  thinkingLevel: ThinkingLevel | undefined,
  persistRuns: boolean,
  signal?: AbortSignal,
): Promise<{ context: HandoffContext; debugSessionPath?: string | undefined } | undefined> {
  let capturedArguments: HandoffExtractionArgs | undefined;
  // Pi does not inject promptSnippet or promptGuidelines when a custom system prompt is active.
  const createHandoffContextTool = defineTool({
    name: "create_handoff_context",
    label: "Create handoff context",
    description:
      "Submit the completed structured briefing for the destination session. Call this tool exactly once to complete extraction.",
    parameters: HANDOFF_EXTRACTION_PARAMETERS,
    execute: async (_toolCallId, params) => {
      capturedArguments = params;
      return {
        content: [{ type: "text", text: "Handoff context captured. Stopping." }],
        details: {},
        terminate: true,
      };
    },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    systemPromptOverride: () => HANDOFF_SYSTEM_PROMPT,
  });
  await resourceLoader.reload();

  const sessionManager = persistRuns
    ? SessionManager.create(ctx.cwd, getDefaultHandoffRunsDir())
    : SessionManager.inMemory(ctx.cwd);
  const debugSessionPath = persistRuns ? sessionManager.getSessionFile() : undefined;
  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    model,
    modelRuntime,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    tools: ["create_handoff_context"],
    customTools: [createHandoffContextTool],
    resourceLoader,
    sessionManager,
  });

  const abortHandler = (): void => {
    void session.abort();
  };

  try {
    signal?.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted) {
      await session.abort();
      return undefined;
    }

    for (let attempt = 1; attempt <= MAX_HANDOFF_EXTRACTION_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) {
        break;
      }
      await session.prompt(
        attempt === 1
          ? buildExtractionPrompt(conversationText, goal)
          : HANDOFF_EXTRACTION_RETRY_PROMPT,
      );
      if (capturedArguments) {
        break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    session.dispose();
  }

  if (signal?.aborted) {
    return undefined;
  }

  if (!capturedArguments) {
    throw new Error("Handoff extraction did not return structured context.");
  }

  const extraction = extractHandoffContextFromArguments(capturedArguments);
  if (!extraction.context) {
    throw new Error(extraction.error);
  }

  return {
    context: extraction.context,
    ...(debugSessionPath ? { debugSessionPath } : {}),
  };
}

export function assembleHandoffDraft(
  sessionId: string,
  sessionPath: string | undefined,
  handoffContext: HandoffContext,
  goal: string,
  requestResponse = false,
): string {
  const sections = [buildContinuityLine(sessionId, sessionPath, requestResponse)];
  const task = goal.trim();

  if (task) {
    sections.push(["## Task", task].join("\n"));
  }

  if (handoffContext.relevantFiles.length > 0) {
    sections.push(
      [
        "## Relevant Files",
        ...handoffContext.relevantFiles.map((filePath) => `- ${filePath}`),
      ].join("\n"),
    );
  }

  if (handoffContext.summary) {
    sections.push(["## Context", handoffContext.summary].join("\n"));
  }

  if (handoffContext.openQuestions.length > 0) {
    sections.push(
      [
        "## Open Questions",
        ...handoffContext.openQuestions.map((question) => `- ${question}`),
      ].join("\n"),
    );
  }

  return sections.join("\n\n").trim();
}

export function extractHandoffContext(
  response: AssistantMessage,
): { context: HandoffContext; error?: undefined } | { context?: undefined; error: string } {
  const toolCall = response.content.find(isCreateHandoffContextToolCall);
  if (!toolCall) {
    return { error: "Handoff extraction did not return structured context." };
  }

  return extractHandoffContextFromArguments(toolCall.arguments);
}

function extractHandoffContextFromArguments(
  argumentsValue: unknown,
): { context: HandoffContext; error?: undefined } | { context?: undefined; error: string } {
  let extraction: HandoffExtractionArgs;
  try {
    extraction = parseTypeBoxValue(
      HANDOFF_EXTRACTION_PARAMETERS,
      argumentsValue,
      "Invalid create_handoff_context arguments",
    );
  } catch {
    return { error: "Handoff extraction did not return structured context." };
  }

  const summary = normalizeText(extraction.summary);
  if (!summary) {
    return { error: "Handoff extraction did not return structured context." };
  }

  return {
    context: {
      summary,
      relevantFiles: normalizeStringArray(extraction.relevantFiles),
      openQuestions: normalizeStringArray(extraction.openQuestions),
    },
  };
}

function buildContinuityLine(
  sessionId: string,
  _sessionPath: string | undefined,
  requestResponse: boolean,
): string {
  const base = `Continuing work from session ${sessionId}. When you lack specific information you can use session_ask.`;
  if (!requestResponse) {
    return base;
  }

  return `${base} When this work is complete, send that session a completion report.`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const uniqueValues = new Set<string>();
  for (const item of value) {
    const normalized = normalizeText(item);
    if (!normalized) {
      continue;
    }

    uniqueValues.add(normalized);
  }

  return [...uniqueValues];
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isCreateHandoffContextToolCall(
  content: TextContent | ThinkingContent | ToolCall,
): content is ToolCall {
  return content.type === "toolCall" && content.name === "create_handoff_context";
}
