import {
  type AssistantMessage,
  complete,
  type Message,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
} from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
} from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { parseTypeBoxValue } from "../shared/typebox.js";

const MAX_RELEVANT_FILES = 12;
const MAX_OPEN_QUESTIONS = 8;

const HANDOFF_SYSTEM_PROMPT = `You extract context for a deliberate session handoff.

You must call create_handoff_context exactly once.

Rules:
- Extract only context that is relevant to the next task.
- Keep the summary compact and concrete.
- Prefer workspace-relative file paths when possible.
- nextTask must be the concrete next action for the new session.
- openQuestions should contain only unresolved items that materially affect the next task.
- If there are no meaningful open questions, omit openQuestions entirely.
- Do not write the final handoff prompt yourself.`;

const HANDOFF_EXTRACTION_PARAMETERS = Type.Object({
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

const HANDOFF_EXTRACTION_TOOL: Tool<typeof HANDOFF_EXTRACTION_PARAMETERS> = {
  name: "create_handoff_context",
  description: "Extract the structured handoff context for the next session.",
  parameters: HANDOFF_EXTRACTION_PARAMETERS,
};

type RequiredHandoffExtractionArgs = Static<typeof REQUIRED_HANDOFF_EXTRACTION_PARAMETERS>;

const REQUIRED_HANDOFF_EXTRACTION_PARAMETERS = Type.Object({
  summary: HANDOFF_EXTRACTION_PARAMETERS.properties.summary,
  nextTask: HANDOFF_EXTRACTION_PARAMETERS.properties.nextTask,
});

export interface HandoffContext {
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
  signal?: AbortSignal,
): Promise<HandoffDraftResult | undefined> {
  if (!ctx.model) {
    throw new Error("No model is available for handoff.");
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(`No API key is available for ${ctx.model.provider}/${ctx.model.id}.`);
  }

  const sessionContext = buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
  );
  if (sessionContext.messages.length === 0) {
    throw new Error("No conversation is available to hand off.");
  }

  const conversationText = serializeConversation(convertToLlm(sessionContext.messages));
  const userMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: buildExtractionPrompt(conversationText, goal),
      },
    ],
    timestamp: Date.now(),
  };

  const response = await complete(
    ctx.model,
    {
      systemPrompt: HANDOFF_SYSTEM_PROMPT,
      messages: [userMessage],
      tools: [HANDOFF_EXTRACTION_TOOL],
    },
    signal
      ? {
          apiKey: auth.apiKey,
          ...(auth.headers ? { headers: auth.headers } : {}),
          signal,
          toolChoice: "any",
        }
      : {
          apiKey: auth.apiKey,
          ...(auth.headers ? { headers: auth.headers } : {}),
          toolChoice: "any",
        },
  );

  if (response.stopReason === "aborted") {
    return undefined;
  }

  if (response.stopReason === "error") {
    throw new Error(response.errorMessage ?? "Handoff generation failed.");
  }

  const handoffContext = extractHandoffContext(response, goal);
  if (!handoffContext) {
    throw new Error("Handoff extraction did not return structured context.");
  }

  const sessionId = ctx.sessionManager.getSessionId();
  const sessionPath = ctx.sessionManager.getSessionFile();

  return {
    draft: assembleHandoffDraft(sessionId, sessionPath, handoffContext, goal),
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

export function assembleHandoffDraft(
  sessionId: string,
  sessionPath: string | undefined,
  handoffContext: HandoffContext,
  goal: string,
): string {
  const sections = [buildContinuityLine(sessionId, sessionPath)];
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
): HandoffContext | undefined {
  const toolCall = response.content.find(isCreateHandoffContextToolCall);
  if (!toolCall) {
    return undefined;
  }

  let requiredArguments: RequiredHandoffExtractionArgs;
  try {
    requiredArguments = parseTypeBoxValue(
      REQUIRED_HANDOFF_EXTRACTION_PARAMETERS,
      toolCall.arguments,
      "Invalid create_handoff_context arguments",
    );
  } catch {
    return undefined;
  }

  const summary = normalizeText(requiredArguments.summary);
  const relevantFiles = normalizeStringArray(toolCall.arguments.relevantFiles, MAX_RELEVANT_FILES);
  const nextTask = normalizeText(requiredArguments.nextTask) || goal.trim();
  const openQuestions = normalizeStringArray(toolCall.arguments.openQuestions, MAX_OPEN_QUESTIONS);

  if (!summary || !nextTask) {
    return undefined;
  }

  return {
    summary,
    relevantFiles,
    nextTask,
    openQuestions,
  };
}

function buildContinuityLine(sessionId: string, _sessionPath: string | undefined): string {
  return `Continuing work from session ${sessionId}. When you lack specific information you can use session_ask.`;
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

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isCreateHandoffContextToolCall(
  content: TextContent | ThinkingContent | ToolCall,
): content is ToolCall {
  return content.type === "toolCall" && content.name === "create_handoff_context";
}
