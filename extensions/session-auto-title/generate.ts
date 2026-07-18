import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AutoTitleContext } from "./context.ts";
import type { AutoTitleTrigger } from "./state.ts";

const AUTO_TITLE_MAX_TOKENS = 64;
const AUTO_TITLE_CHAR_MAX = 80;

export interface AutoTitleFailure {
  at: string;
  trigger: AutoTitleTrigger;
  model: string;
  message: string;
}

export interface AutoTitleGeneration {
  systemPrompt: string;
  timeoutMs: number;
  thinkingLevel: ThinkingLevel | undefined;
}

export type AutoTitleGenerationResult =
  | {
      ok: true;
      title: string;
    }
  | {
      ok: false;
      failure: AutoTitleFailure;
    };

export async function generateAutoTitle(
  modelRuntime: ModelRuntime,
  model: Model<Api>,
  context: AutoTitleContext,
  trigger: AutoTitleTrigger,
  generation: AutoTitleGeneration,
): Promise<AutoTitleGenerationResult> {
  if (!context.conversationText) {
    return {
      ok: false,
      failure: createAutoTitleFailure(
        trigger,
        model,
        "No conversation available for auto-title generation.",
      ),
    };
  }

  const shouldPreserveTitle = trigger === "periodic" && Boolean(context.currentTitle?.trim());
  const resolvedSystemPrompt = buildAutoTitleSystemPrompt(
    generation.systemPrompt,
    shouldPreserveTitle,
  );
  const userPrompt = buildAutoTitlePrompt(context, resolvedSystemPrompt, shouldPreserveTitle);
  const message: UserMessage = {
    role: "user",
    content: [{ type: "text", text: userPrompt }],
    timestamp: Date.now(),
  };

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), generation.timeoutMs);
  const thinkingLevel = generation.thinkingLevel;

  try {
    const requestContext = {
      systemPrompt: resolvedSystemPrompt,
      messages: [message],
    };
    writeAutoTitleDebugRequest(model, trigger, requestContext);
    const response = await modelRuntime.completeSimple(model, requestContext, {
      maxTokens: AUTO_TITLE_MAX_TOKENS,
      ...(thinkingLevel && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
      signal: abortController.signal,
    });
    writeAutoTitleDebugResponse(model, trigger, response);

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      const fallbackMessage =
        response.stopReason === "aborted" ? "Request was aborted." : "Provider returned an error.";
      return {
        ok: false,
        failure: createAutoTitleFailure(trigger, model, response.errorMessage || fallbackMessage),
      };
    }

    const normalizedTitle = normalizeGeneratedAutoTitle(extractResponseText(response.content));
    if (!normalizedTitle) {
      return {
        ok: false,
        failure: createAutoTitleFailure(trigger, model, "Model returned an empty title."),
      };
    }

    return {
      ok: true,
      title: normalizedTitle,
    };
  } catch (error) {
    return {
      ok: false,
      failure: createAutoTitleFailure(trigger, model, extractErrorMessage(error)),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createAutoTitleFailure(
  trigger: AutoTitleTrigger,
  model: Model<Api> | undefined,
  message: string,
): AutoTitleFailure {
  return {
    at: new Date().toISOString(),
    trigger,
    model: formatModelLabel(model),
    message,
  };
}

function buildAutoTitleSystemPrompt(systemPrompt: string, shouldPreserveTitle: boolean): string {
  if (!shouldPreserveTitle) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\nPreserve the current title unless the conversation has meaningfully shifted.`;
}

function buildAutoTitlePrompt(
  context: AutoTitleContext,
  titleInstructions: string,
  shouldPreserveTitle: boolean,
): string {
  const sections = ["Generate the title from this session context.", "<session_context>"];

  if (context.cwd) {
    sections.push(`<cwd>${context.cwd}</cwd>`);
  }

  sections.push(`<counts>\n${formatCounts(context)}\n</counts>`);

  if (shouldPreserveTitle) {
    sections.push(`<current_title>${context.currentTitle ?? ""}</current_title>`);
  }

  sections.push(`<conversation>\n${context.conversationText || "(none)"}\n</conversation>`);
  sections.push("</session_context>");
  sections.push(`<title_instructions>\n${titleInstructions}\n</title_instructions>`);

  return sections.join("\n\n");
}

function normalizeGeneratedAutoTitle(value: string): string | undefined {
  const withoutQuotes = value.trim().replace(/^["'`]+|["'`]+$/g, "");
  const collapsed = withoutQuotes
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!collapsed) {
    return undefined;
  }

  const truncated = collapsed.slice(0, AUTO_TITLE_CHAR_MAX).trim();
  return truncated || undefined;
}

function writeAutoTitleDebugRequest(
  model: Model<Api>,
  trigger: AutoTitleTrigger,
  request: unknown,
): void {
  writeAutoTitleDebugEntry({
    phase: "request",
    trigger,
    model: formatModelLabel(model),
    request,
  });
}

function writeAutoTitleDebugResponse(
  model: Model<Api>,
  trigger: AutoTitleTrigger,
  response: unknown,
): void {
  writeAutoTitleDebugEntry({
    phase: "response",
    trigger,
    model: formatModelLabel(model),
    response,
  });
}

function writeAutoTitleDebugEntry(entry: Record<string, unknown>): void {
  try {
    const dir = join(homedir(), ".pi", "agent", "pi-sessions");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "auto-title-debug.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );
  } catch {
    // Debug logging must not affect title generation.
  }
}

function extractResponseText(content: unknown[]): string {
  return content
    .filter(
      (part): part is TextContent =>
        isObject(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function formatCounts(context: AutoTitleContext): string {
  return [
    `user_turns: ${context.userTurnCount}`,
    `assistant_turns: ${context.assistantTurnCount}`,
  ].join("\n");
}

function formatModelLabel(model: Model<Api> | undefined): string {
  if (!model) {
    return "(no model resolved)";
  }

  return `${model.provider}/${model.id}`;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  return "Unknown provider error.";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
