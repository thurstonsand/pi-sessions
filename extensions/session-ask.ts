import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { renderSessionTreeMarkdown } from "./session-search/extract.js";

const SESSION_ASK_SYSTEM_PROMPT = `You are analyzing a Pi coding session transcript. The transcript includes the entire session tree, including abandoned branches and summaries.

Answer the user's question using only the session contents. Be specific and concise. Include exact file paths, decisions, and outcomes when present. If the answer is not in the session, say so clearly.`;

interface TextContentBlock {
  type: "text";
  text: string;
}

export default function sessionAskExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "session_ask",
    label: "Session Ask",
    description:
      "Read an entire Pi session tree and answer a specific question about that session.",
    parameters: Type.Object({
      sessionPath: Type.String({ description: "Full path to the session .jsonl file." }),
      question: Type.String({ description: "Question to answer using the full session tree." }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const question = params.question.trim();
      if (!question) {
        return {
          content: [{ type: "text", text: "session_ask requires a non-empty question." }],
          details: { error: true, sessionPath: params.sessionPath },
        };
      }

      if (!ctx.model) {
        return {
          content: [{ type: "text", text: "No active model is available for session_ask." }],
          details: { error: true },
        };
      }

      const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: `No API key is available for ${ctx.model.provider}/${ctx.model.id}.`,
            },
          ],
          details: { error: true },
        };
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text: [`session_path: ${params.sessionPath}`, `question: ${question}`].join("\n"),
          },
        ],
        details: { phase: "load" },
      });

      let rendered: ReturnType<typeof renderSessionTreeMarkdown>;
      try {
        rendered = renderSessionTreeMarkdown(params.sessionPath);
      } catch (error) {
        return {
          content: [{ type: "text", text: formatSessionAskLoadError(params.sessionPath, error) }],
          details: { error: true, sessionPath: params.sessionPath, question },
        };
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text: formatSessionAskHeader(rendered.sessionId, rendered.sessionName, question),
          },
        ],
        details: { phase: "ask", sessionId: rendered.sessionId, sessionName: rendered.sessionName },
      });

      const userMessage: Message = {
        role: "user",
        content: [
          {
            type: "text",
            text: [`## Session`, rendered.markdown, "", "## Question", question].join("\n"),
          },
        ],
        timestamp: Date.now(),
      };

      const completionOptions: { apiKey: string; signal?: AbortSignal } = { apiKey };
      if (signal) {
        completionOptions.signal = signal;
      }

      const response = await complete(
        ctx.model,
        { systemPrompt: SESSION_ASK_SYSTEM_PROMPT, messages: [userMessage] },
        completionOptions,
      );

      if (response.stopReason === "aborted") {
        return {
          content: [{ type: "text", text: "Session ask was cancelled." }],
          details: { cancelled: true },
        };
      }

      const answer = collectTextBlocks(response.content).join("\n").trim();

      return {
        content: [
          {
            type: "text",
            text: [
              formatSessionAskHeader(rendered.sessionId, rendered.sessionName, question),
              answer || "No answer generated.",
            ].join("\n\n"),
          },
        ],
        details: {
          sessionId: rendered.sessionId,
          sessionName: rendered.sessionName,
          sessionPath: params.sessionPath,
          question,
        },
      };
    },
  });
}

function collectTextBlocks(content: Array<{ type: string; text?: string }>): string[] {
  return content.filter(isTextContentBlock).map((block) => block.text);
}

function formatSessionAskHeader(sessionId: string, sessionName: string, question: string): string {
  return [
    `session: ${sessionId}`,
    `title: ${sessionName || "[unnamed]"}`,
    `question: ${question}`,
  ].join("\n");
}

function formatSessionAskLoadError(sessionPath: string, error: unknown): string {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return `Session file not found: ${sessionPath}`;
  }

  return `Unable to load session file: ${sessionPath}`;
}

function isTextContentBlock(content: { type: string; text?: string }): content is TextContentBlock {
  return content.type === "text" && typeof content.text === "string";
}
