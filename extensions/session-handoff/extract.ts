import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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

const HANDOFF_SYSTEM_PROMPT = `You extract context for a deliberate session handoff.

You must call create_handoff_context exactly once.

Rules:
- Extract only context that is relevant to the next task.
- Keep the summary compact and concrete.
- Prefer workspace-relative file paths when possible.
- title must be a short session title for the new handoff thread, 64 characters or less, without prefixes like "Handoff:" or otherwise referencing the current thread.
- nextTask must be the concrete next action for the new session.
- openQuestions should contain only unresolved items that materially affect the next task.
- If there are no meaningful open questions, omit openQuestions entirely.
- Do not write the final handoff prompt yourself.`;

const HANDOFF_EXTRACTION_PARAMETERS = Type.Object({
  title: Type.String({
    description: "Short display title for the new handoff session.",
  }),
  summary: Type.String({
    description: "Only the context relevant to the next task.",
  }),
  relevantFiles: Type.Array(Type.String(), {
    description: "Relevant workspace-relative file paths when possible.",
  }),
  nextTask: Type.String({
    description: "The concrete next task for the new session.",
  }),
  openQuestions: Type.Optional(
    Type.Array(Type.String(), {
      description: "Open questions that matter to the next task. Omit when there are none.",
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

export async function generateHandoffDraft(
  ctx: ExtensionContext,
  goal: string,
  thinkingLevel: ThinkingLevel | undefined,
  signal?: AbortSignal,
  requestResponse = false,
): Promise<HandoffDraftResult | undefined> {
  if (!ctx.model) {
    throw new Error("No model is available for handoff.");
  }

  return generateHandoffDraftFromSessionManager(
    ctx,
    ctx.sessionManager,
    goal,
    thinkingLevel,
    signal,
    requestResponse,
  );
}

export async function generateHandoffDraftFromSessionManager(
  ctx: ExtensionContext,
  sourceSessionManager: ExtensionContext["sessionManager"],
  goal: string,
  thinkingLevel: ThinkingLevel | undefined,
  signal?: AbortSignal,
  requestResponse = false,
): Promise<HandoffDraftResult | undefined> {
  if (!ctx.model) {
    throw new Error("No model is available for handoff.");
  }

  const model = ctx.model;
  const sessionContext = buildSessionContext(
    sourceSessionManager.getEntries(),
    sourceSessionManager.getLeafId(),
  );
  if (sessionContext.messages.length === 0) {
    throw new Error("No conversation is available to hand off.");
  }

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
  return [
    "## Conversation",
    conversationText,
    "",
    "## Goal",
    goal,
    "",
    "Call create_handoff_context exactly once.",
  ].join("\n");
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
  const createHandoffContextTool = defineTool({
    name: "create_handoff_context",
    label: "Create handoff context",
    description: "Extract the structured handoff context for the next session.",
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
    appendSystemPromptOverride: (base) => [...base, HANDOFF_SYSTEM_PROMPT],
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
