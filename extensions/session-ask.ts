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
          { type: "text", text: `Loading full session tree from ${params.sessionPath}...` },
        ],
        details: { phase: "load" },
      });

      const rendered = renderSessionTreeMarkdown(params.sessionPath);

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Asking ${ctx.model.provider}/${ctx.model.id} about session ${rendered.sessionId}...`,
          },
        ],
        details: { phase: "ask" },
      });

      const userMessage: Message = {
        role: "user",
        content: [
          {
            type: "text",
            text: [`## Session`, rendered.markdown, "", "## Question", params.question].join("\n"),
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
        content: [{ type: "text", text: answer || "No answer generated." }],
        details: {
          sessionId: rendered.sessionId,
          sessionName: rendered.sessionName,
          sessionPath: params.sessionPath,
          question: params.question,
        },
      };
    },
  });
}

function collectTextBlocks(content: Array<{ type: string; text?: string }>): string[] {
  return content.filter(isTextContentBlock).map((block) => block.text);
}

function isTextContentBlock(content: { type: string; text?: string }): content is TextContentBlock {
  return content.type === "text" && typeof content.text === "string";
}
