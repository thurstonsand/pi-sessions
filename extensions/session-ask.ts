import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runSessionAskAgent } from "./session-ask/agent.ts";
import { renderSessionAskResult } from "./session-ask/renderer.ts";
import type {
  SessionAskProgressDetails,
  SessionAskRelevantFile,
  SessionAskResultDetails,
} from "./session-ask/tool-contract.ts";
import {
  getSessionById,
  type SessionLineageRow,
  withSessionIndex,
} from "./shared/session-index/index.ts";
import { isExactSessionId } from "./shared/session-ui.ts";
import { loadSettings } from "./shared/settings.ts";

interface SessionAskToolParams {
  session: string;
  question: string;
}

export default function sessionAskExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();

  pi.registerTool({
    name: "session_ask",
    label: "Session Ask",
    description: "Interrogate a Pi session",
    promptSnippet: "Recall information, decisions, or reasoning from a Pi session by id",
    promptGuidelines: ["Use session_ask with focused questions rather than broad recap requests."],
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
        throw new Error("session_ask requires a session id.");
      }

      const question = params.question.trim();
      if (!question) {
        throw new Error("session_ask requires a question.");
      }

      const resolvedTarget = resolveSessionAskTarget(sessionId, settings.index.path);
      if (!resolvedTarget.resolved) {
        throw new Error(resolvedTarget.error ?? "Unable to resolve session id.");
      }

      const progressDetails: SessionAskProgressDetails = {
        question,
        sessionId: resolvedTarget.resolved.sessionId,
        sessionName: resolvedTarget.resolved.sessionName,
        sessionPath: resolvedTarget.resolved.sessionPath,
      };
      onUpdate?.({
        content: [{ type: "text", text: "Reading session..." }],
        details: progressDetails,
      });

      onUpdate?.({
        content: [
          {
            type: "text",
            text: formatSessionAskHeader(
              resolvedTarget.resolved.sessionId,
              resolvedTarget.resolved.sessionName,
              question,
            ),
          },
        ],
        details: progressDetails,
      });

      const agentResult = await runSessionAskAgent({
        ctx,
        target: resolvedTarget.resolved,
        question,
        indexPath: settings.index.path,
        askSettings: settings.ask,
        thinkingLevel: pi.getThinkingLevel(),
        signal,
      });

      const answer = agentResult?.answer || "Could not determine an answer from the session.";
      const relevantFiles = agentResult?.relevantFiles ?? [];

      const details: SessionAskResultDetails = {
        answer,
        ...(agentResult?.debugSessionPath
          ? { debugSessionPath: agentResult.debugSessionPath }
          : {}),
        relevantFiles,
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
              formatSessionAskHeader(
                resolvedTarget.resolved.sessionId,
                resolvedTarget.resolved.sessionName,
                question,
              ),
              formatSessionAskAnswer(answer, relevantFiles, agentResult?.debugSessionPath),
            ].join("\n\n"),
          },
        ],
        details,
      };
    },
    renderResult: renderSessionAskResult,
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

  try {
    return withSessionIndex(indexPath, { mode: "read", required: true }, ({ db }) => {
      const row = getSessionById(db, sessionId);
      if (!row) {
        return { error: `No indexed session found for id: ${sessionId}` };
      }

      return { resolved: row };
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function formatSessionAskHeader(sessionId: string, sessionName: string, question: string): string {
  return [
    `session: ${sessionId}`,
    `title: ${sessionName || "[unnamed]"}`,
    `question: ${question}`,
  ].join("\n");
}

function formatSessionAskAnswer(
  answer: string,
  relevantFiles: SessionAskRelevantFile[],
  debugSessionPath: string | undefined,
): string {
  const lines = [answer || "No answer generated."];
  if (relevantFiles.length > 0) {
    lines.push("", "Relevant files:");
    lines.push(...relevantFiles.map((file) => `- ${file.path}: ${file.reason}`));
  }
  if (debugSessionPath) {
    lines.push("", `debug_session: ${debugSessionPath}`);
  }
  return lines.join("\n");
}
