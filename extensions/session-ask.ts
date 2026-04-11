import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type RenderedSessionTree, renderSessionTreeMarkdown } from "./session-search/extract.js";
import {
  getIndexStatus,
  getSessionById,
  INDEX_SCHEMA_VERSION,
  openIndexDatabase,
  type SessionLineageRow,
} from "./shared/session-index/index.js";
import { formatSessionTitleOrShortId, isExactSessionId } from "./shared/session-ui.js";
import { loadSettings } from "./shared/settings.js";

const SESSION_ASK_SYSTEM_PROMPT = `You are analyzing a Pi coding session transcript. The transcript includes the entire session tree, including abandoned branches and summaries.

Answer the user's question using only the session contents. Be specific and concise. Include exact file paths, decisions, and outcomes when present. If the answer is not in the session, say so clearly.`;

const COLLAPSED_ANSWER_PREVIEW_ROWS = 6;

interface SessionAskToolParams {
  session: string;
  question: string;
}

interface SessionAskToolDetails {
  cancelled?: boolean | undefined;
  error?: boolean | undefined;
  answer?: string | undefined;
  question?: string | undefined;
  sessionId?: string | undefined;
  sessionName?: string | undefined;
  sessionPath?: string | undefined;
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
    description: "Interrogate a Pi session",
    promptSnippet:
      "Use when you have a session id and want to recall information, decisions, reasoning, etc from it",
    promptGuidelines: ["Prefer focused follow-up questions over broad recap requests"],
    parameters: Type.Object({
      session: Type.String({
        description: "Bare UUID for the session",
      }),
      question: Type.String({
        description: "What to extract, verify, or explain from that session",
      }),
    }),
    async execute(_toolCallId, params: SessionAskToolParams, signal, onUpdate, ctx) {
      const sessionId = params.session.trim();
      if (!sessionId) {
        return errorResult("session_ask requires a session id.", { error: true });
      }

      const question = params.question.trim();
      if (!question) {
        return errorResult("session_ask requires a question.", { error: true, sessionId });
      }

      const resolvedTarget = resolveSessionAskTarget(sessionId, settings.index.path);
      if (!resolvedTarget.resolved) {
        return errorResult(resolvedTarget.error ?? "Unable to resolve session id.", {
          error: true,
          sessionId,
          question,
        });
      }

      if (!ctx.model) {
        return errorResult("No active model is available for session_ask.", { error: true });
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok || !auth.apiKey) {
        return errorResult(`No API key is available for ${ctx.model.provider}/${ctx.model.id}.`, {
          error: true,
        });
      }

      const progressDetails: SessionAskToolDetails = {
        question,
        sessionId: resolvedTarget.resolved.sessionId,
        sessionName: resolvedTarget.resolved.sessionName,
        sessionPath: resolvedTarget.resolved.sessionPath,
      };
      onUpdate?.({
        content: [{ type: "text", text: "Reading session..." }],
        details: progressDetails,
      });

      let rendered: RenderedSessionTree;
      try {
        rendered = renderSessionTreeMarkdown(resolvedTarget.resolved.sessionPath);
      } catch (error) {
        return errorResult(formatSessionAskLoadError(resolvedTarget.resolved.sessionPath, error), {
          error: true,
          sessionId,
          sessionPath: resolvedTarget.resolved.sessionPath,
          question,
        });
      }

      const loadedDetails: SessionAskToolDetails = {
        question,
        sessionId: rendered.sessionId,
        sessionName: rendered.sessionName,
        sessionPath: resolvedTarget.resolved.sessionPath,
      };
      onUpdate?.({
        content: [
          {
            type: "text",
            text: formatSessionAskHeader(rendered.sessionId, rendered.sessionName, question),
          },
        ],
        details: loadedDetails,
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
        return errorResult("Session ask was cancelled.", { cancelled: true });
      }

      const answer = collectTextBlocks(response.content).join("\n").trim();

      const details: SessionAskToolDetails = {
        answer,
        sessionId: resolvedTarget.resolved.sessionId,
        sessionName: resolvedTarget.resolved.sessionName,
        sessionPath: resolvedTarget.resolved.sessionPath,
        question,
      };
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
        details,
      };
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as SessionAskToolDetails | undefined;
      const content = result.content[0];
      if (content?.type !== "text") {
        return new Text(theme.fg("error", "No session output"), 0, 0);
      }

      if (isPartial) {
        const lines = [theme.bold(theme.fg("warning", "Reading session..."))];
        if (details?.sessionId || details?.sessionName) {
          const identity = formatSessionTitleOrShortId(details.sessionName, details.sessionId);
          lines.push(`title: ${theme.fg("accent", identity)}`);
        }
        if (details?.question) {
          lines.push(theme.fg("muted", `prompt: ${details.question}`));
        }
        return new Text(lines.join("\n"), 0, 0);
      }

      if (details?.cancelled) {
        return new Text(theme.fg("warning", content.text), 0, 0);
      }

      if (details?.error) {
        return new Text(theme.fg("error", content.text), 0, 0);
      }

      const answer = (details?.answer ?? "").trim() || "No answer generated.";
      const identity = formatSessionTitleOrShortId(details?.sessionName, details?.sessionId);
      const lines = [`title: ${theme.bold(identity)}`];
      if (details?.question) {
        lines.push(theme.fg("muted", `prompt: ${details.question}`));
        lines.push("");
      }
      lines.push(...formatSessionAskAnswerPreview(answer, expanded, theme));
      return new Text(lines.join("\n"), 0, 0);
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

function errorResult(
  text: string,
  details: SessionAskToolDetails,
): { content: Array<{ type: "text"; text: string }>; details: SessionAskToolDetails } {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function formatSessionAskAnswerPreview(answer: string, expanded: boolean, theme: Theme): string[] {
  const lines = answer.split(/\r?\n/);
  if (expanded || lines.length <= COLLAPSED_ANSWER_PREVIEW_ROWS) {
    return lines;
  }

  return [...lines.slice(0, COLLAPSED_ANSWER_PREVIEW_ROWS), theme.fg("dim", "...")];
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
