import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  getIndexStatus,
  getSessionById,
  INDEX_SCHEMA_VERSION,
  openIndexDatabase,
  type SessionLineageRow,
} from "./session-search/db.js";
import { type RenderedSessionTree, renderSessionTreeMarkdown } from "./session-search/extract.js";
import { loadSettings } from "./shared/settings.js";

const SESSION_ASK_SYSTEM_PROMPT = `You are analyzing a Pi coding session transcript. The transcript includes the entire session tree, including abandoned branches and summaries.

Answer the user's question using only the session contents. Be specific and concise. Include exact file paths, decisions, and outcomes when present. If the answer is not in the session, say so clearly.`;

interface SessionAskToolParams {
  session: string;
  question: string;
}

interface TextContentBlock {
  type: "text";
  text: string;
}

export default function sessionAskExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();

  pi.registerTool({
    name: "session_ask",
    label: "Session Ask",
    description:
      "Read an entire Pi session tree and answer a specific question about that session.",
    parameters: Type.Object({
      session: Type.String({
        description: "session UUID.",
      }),
      question: Type.String({
        description: "Question to extract from the session.",
      }),
    }),
    async execute(_toolCallId, params: SessionAskToolParams, signal, onUpdate, ctx) {
      const sessionId = params.session.trim();
      if (!sessionId) {
        return {
          content: [
            {
              type: "text",
              text: "session_ask requires a session id.",
            },
          ],
          details: { error: true, session: params.session },
        };
      }

      const question = params.question.trim();
      if (!question) {
        return {
          content: [
            {
              type: "text",
              text: "session_ask requires a question.",
            },
          ],
          details: { error: true, session: sessionId },
        };
      }

      const resolvedTarget = resolveSessionAskTarget(sessionId, settings.index.path);
      if (!resolvedTarget.resolved) {
        return {
          content: [
            {
              type: "text",
              text: resolvedTarget.error ?? "Unable to resolve session id.",
            },
          ],
          details: { error: true, session: sessionId, question },
        };
      }

      if (!ctx.model) {
        return {
          content: [
            {
              type: "text",
              text: "No active model is available for session_ask.",
            },
          ],
          details: { error: true },
        };
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok || !auth.apiKey) {
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
            text: [
              `session: ${sessionId}`,
              `session_path: ${resolvedTarget.resolved.sessionPath}`,
              `question: ${question}`,
            ].join("\n"),
          },
        ],
        details: {
          phase: "load",
          sessionId: resolvedTarget.resolved.sessionId,
        },
      });

      let rendered: RenderedSessionTree;
      try {
        rendered = renderSessionTreeMarkdown(resolvedTarget.resolved.sessionPath);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: formatSessionAskLoadError(resolvedTarget.resolved.sessionPath, error),
            },
          ],
          details: {
            error: true,
            session: sessionId,
            sessionPath: resolvedTarget.resolved.sessionPath,
            question,
          },
        };
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text: formatSessionAskHeader(rendered.sessionId, rendered.sessionName, question),
          },
        ],
        details: {
          phase: "ask",
          sessionId: rendered.sessionId,
          sessionName: rendered.sessionName,
        },
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

      const response = await complete(
        ctx.model,
        { systemPrompt: SESSION_ASK_SYSTEM_PROMPT, messages: [userMessage] },
        signal
          ? {
              apiKey: auth.apiKey,
              ...(auth.headers ? { headers: auth.headers } : {}),
              signal,
            }
          : {
              apiKey: auth.apiKey,
              ...(auth.headers ? { headers: auth.headers } : {}),
            },
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
          session: sessionId,
          sessionId: resolvedTarget.resolved.sessionId,
          sessionName: resolvedTarget.resolved.sessionName,
          sessionPath: resolvedTarget.resolved.sessionPath,
          question,
        },
      };
    },
  });
}

function resolveSessionAskTarget(
  sessionId: string,
  indexPath: string,
): {
  resolved?: SessionLineageRow | undefined;
  error?: string | undefined;
} {
  if (!isExactSessionId(sessionId)) {
    return {
      error:
        "session_ask requires an exact session UUID. Use autocomplete or session_search to find it.",
    };
  }

  const status = getIndexStatus(indexPath);
  if (!status.exists || status.schemaVersion !== INDEX_SCHEMA_VERSION) {
    return {
      error: `Session index missing or incompatible at ${indexPath}. Run /session-index and press r to rebuild it.`,
    };
  }

  const db = openIndexDatabase(status.dbPath, { create: false });
  try {
    const row = getSessionById(db, sessionId);
    if (!row) {
      return { error: `No indexed session found for id: ${sessionId}` };
    }

    return { resolved: row };
  } finally {
    db.close();
  }
}

function isExactSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
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
