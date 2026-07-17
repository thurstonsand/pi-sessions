import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionContext } from "@earendil-works/pi-coding-agent";
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
import { parseTypeBoxValue } from "../shared/typebox.ts";

const MAX_RELEVANT_FILES = 12;
const MAX_OPEN_QUESTIONS = 8;
const MAX_HANDOFF_TITLE_LENGTH = 64;

const HANDOFF_SYSTEM_PROMPT = `You extract context for a deliberate session handoff. You are preparing a briefing for a new destination session from a historical source snapshot.

The Handoff Goal states why the destination session is being created. Use the source snapshot to make that goal concrete and actionable.`;

const HANDOFF_EXTRACTION_PARAMETERS = Type.Object({
  title: Type.String({
    description:
      "Short display title for the destination session, 64 characters or less. Do not prefix it with “Handoff:” or describe the source thread.",
  }),
  summary: Type.String({
    description: "Compact, concrete source context relevant to the destination task.",
  }),
  relevantFiles: Type.Array(Type.String(), {
    description: "Relevant workspace-relative file paths when possible.",
  }),
  nextTask: Type.String({
    description:
      "Concrete, actionable destination task synthesized from the Handoff Goal and Source Snapshot.",
  }),
  openQuestions: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Unresolved questions that materially affect the destination task. Omit when there are none.",
    }),
  ),
});

type HandoffExtractionArgs = Static<typeof HANDOFF_EXTRACTION_PARAMETERS>;
type RequiredHandoffExtractionArgs = Static<typeof REQUIRED_HANDOFF_EXTRACTION_PARAMETERS>;

const REQUIRED_HANDOFF_EXTRACTION_PARAMETERS = Type.Object({
  title: HANDOFF_EXTRACTION_PARAMETERS.properties.title,
  summary: HANDOFF_EXTRACTION_PARAMETERS.properties.summary,
  nextTask: HANDOFF_EXTRACTION_PARAMETERS.properties.nextTask,
});

export interface HandoffContext {
  title: string;
  summary: string;
  relevantFiles: string[];
  nextTask: string;
  openQuestions: string[];
}

export interface HandoffDraftResult {
  draft: string;
  context: HandoffContext;
  sessionId: string;
  sessionPath?: string | undefined;
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
  sourceSessionManager: ExtensionContext["sessionManager"],
  sourceLeafId: string,
  goal: string,
  thinkingLevel: ThinkingLevel | undefined,
  signal?: AbortSignal,
  requestResponse = false,
): Promise<HandoffDraftResult | undefined> {
  if (!ctx.model) {
    throw new Error("No model is available for handoff.");
  }

  const model = ctx.model;
  const sessionContext = resolveHandoffSource(sourceSessionManager, sourceLeafId);

  const conversationText = serializeConversation(convertToLlm(sessionContext.messages));
  const handoffContext = await runHandoffExtractionAgent(
    ctx,
    model,
    conversationText,
    goal,
    thinkingLevel,
    signal,
  );
  if (!handoffContext) {
    return undefined;
  }

  const sessionId = sourceSessionManager.getSessionId();
  const sessionPath = sourceSessionManager.getSessionFile();

  return {
    draft: assembleHandoffDraft(sessionId, sessionPath, handoffContext, goal, requestResponse),
    context: handoffContext,
    sessionId,
    sessionPath,
  };
}

export function buildExtractionPrompt(conversationText: string, goal: string): string {
  return ["## Source Snapshot", conversationText, "", "## Handoff Goal", goal].join("\n");
}

async function runHandoffExtractionAgent(
  ctx: ExtensionContext,
  model: Model<Api>,
  conversationText: string,
  goal: string,
  thinkingLevel: ThinkingLevel | undefined,
  signal?: AbortSignal,
): Promise<HandoffContext | undefined> {
  let capturedArguments: HandoffExtractionArgs | undefined;
  // Pi does not inject promptSnippet or promptGuidelines when a custom system prompt is active.
  const createHandoffContextTool = defineTool({
    name: "create_handoff_context",
    label: "Create handoff context",
    description:
      "Submit the completed structured briefing for the destination session. You must call this tool to complete extraction. Calling it ends the extraction run, so finish any workspace exploration first.",
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

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    model,
    modelRegistry: ctx.modelRegistry,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    tools: ["read", "grep", "find", "ls", "create_handoff_context"],
    customTools: [createHandoffContextTool],
    resourceLoader,
    sessionManager: SessionManager.inMemory(ctx.cwd),
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

    await session.prompt(buildExtractionPrompt(conversationText, goal));
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

  const extraction = extractHandoffContextFromArguments(capturedArguments, goal);
  if (!extraction.context) {
    throw new Error(extraction.error);
  }

  return extraction.context;
}

export function assembleHandoffDraft(
  sessionId: string,
  sessionPath: string | undefined,
  handoffContext: HandoffContext,
  goal: string,
  requestResponse = false,
): string {
  const sections = [buildContinuityLine(sessionId, sessionPath, requestResponse)];
  const nextTask = handoffContext.nextTask.trim() || goal.trim();

  if (nextTask) {
    sections.push(["## Task", nextTask].join("\n"));
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
  goal: string,
): { context: HandoffContext; error?: undefined } | { context?: undefined; error: string } {
  const toolCall = response.content.find(isCreateHandoffContextToolCall);
  if (!toolCall) {
    return { error: "Handoff extraction did not return structured context." };
  }

  return extractHandoffContextFromArguments(toolCall.arguments, goal);
}

function extractHandoffContextFromArguments(
  argumentsValue: unknown,
  goal: string,
): { context: HandoffContext; error?: undefined } | { context?: undefined; error: string } {
  let requiredArguments: RequiredHandoffExtractionArgs;
  try {
    requiredArguments = parseTypeBoxValue(
      REQUIRED_HANDOFF_EXTRACTION_PARAMETERS,
      argumentsValue,
      "Invalid create_handoff_context arguments",
    );
  } catch {
    return { error: "Handoff extraction did not return structured context." };
  }

  const title = normalizeText(requiredArguments.title);
  if (title.length > MAX_HANDOFF_TITLE_LENGTH) {
    return { error: "Handoff title must be 64 characters or less." };
  }

  const summary = normalizeText(requiredArguments.summary);
  const relevantFiles = getRelevantFiles(argumentsValue);
  const nextTask = normalizeText(requiredArguments.nextTask) || goal.trim();
  const openQuestions = getOpenQuestions(argumentsValue);

  if (!summary || !nextTask || !title) {
    return { error: "Handoff extraction did not return structured context." };
  }

  return {
    context: {
      title,
      summary,
      relevantFiles,
      nextTask,
      openQuestions,
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

  return `${base} When this work is complete, send that session a completion report with session_send_message.`;
}

function normalizeStringArray(value: unknown, limit: number): string[] {
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
    if (uniqueValues.size >= limit) {
      break;
    }
  }

  return [...uniqueValues];
}

function getRelevantFiles(argumentsValue: unknown): string[] {
  if (!isRecord(argumentsValue)) {
    return [];
  }

  return normalizeStringArray(argumentsValue.relevantFiles, MAX_RELEVANT_FILES);
}

function getOpenQuestions(argumentsValue: unknown): string[] {
  if (!isRecord(argumentsValue)) {
    return [];
  }

  return normalizeStringArray(argumentsValue.openQuestions, MAX_OPEN_QUESTIONS);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCreateHandoffContextToolCall(
  content: TextContent | ThinkingContent | ToolCall,
): content is ToolCall {
  return content.type === "toolCall" && content.name === "create_handoff_context";
}
