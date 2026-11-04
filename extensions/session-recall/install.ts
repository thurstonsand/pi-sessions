import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { installRecallTool } from "../hosts/install.ts";
import { isSessionStarting } from "../session-handoff/metadata.ts";
import type { IndexHandle } from "../shared/composition.ts";
import type { ModelRuntimeProvider } from "../shared/model-runtime.ts";
import { renderToolNameCall } from "../shared/rendering/tool-name-call.ts";
import {
  getSessionById,
  type SessionLineageRow,
  withSessionIndex,
} from "../shared/session-index/index.ts";
import { isExactSessionId } from "../shared/session-ui.ts";
import type { SessionSettings } from "../shared/settings.ts";
import { runSessionRecallAgent } from "./agent.ts";
import { renderSessionRecallResult } from "./renderer.ts";
import {
  SESSION_RECALL_OUTPUT_SCHEMA,
  type SessionRecallOutput,
  type SessionRecallProgressDetails,
  type SessionRecallRelevantFile,
  type SessionRecallResultDetails,
} from "./tool-contract.ts";

interface SessionRecallToolParams {
  session: string;
  question: string;
}

export function installRecall(
  pi: ExtensionAPI,
  deps: {
    settings: SessionSettings;
    index: IndexHandle;
    claimsRecall(): boolean;
    getModelRuntime: ModelRuntimeProvider;
    shouldMessageSubagent?: (sessionId: string) => Promise<boolean>;
  },
): { refresh(): void } {
  const { settings } = deps;
  const indexPath = deps.index.path;

  return installRecallTool(pi, deps.claimsRecall, {
    name: "session_recall",
    label: "Recall Session",
    description: "Interrogate a Pi session transcript",
    annotations: { readOnlyHint: true, openWorldHint: false },
    promptSnippet: "Recall information, decisions, or reasoning from a Pi session by id",
    promptGuidelines: [
      "Ask session_recall focused questions, not for a recap.",
      ...(deps.shouldMessageSubagent
        ? ["To ask an unfinished subagent, message it with subagent_send instead."]
        : []),
    ],
    parameters: Type.Object({
      session: Type.String({
        description: "Bare UUID for the session",
      }),
      question: Type.String({
        description: "What to find in that session's transcript",
      }),
    }),
    outputSchema: SESSION_RECALL_OUTPUT_SCHEMA,
    async execute(_toolCallId, params: SessionRecallToolParams, signal, onUpdate, ctx) {
      const sessionId = params.session.trim();
      if (!sessionId) {
        throw new Error("session_recall requires a session id.");
      }

      const question = params.question.trim();
      if (!question) {
        throw new Error("session_recall requires a question.");
      }

      if (!isExactSessionId(sessionId)) {
        throw new Error(
          "session_recall requires an exact session UUID. Use autocomplete or session_search to find it.",
        );
      }

      // Unfinished children may not have reached the index yet.
      if (await deps.shouldMessageSubagent?.(sessionId)) {
        throw new Error(
          "That session is your unfinished subagent. Use subagent_send to ask it directly.",
        );
      }

      const resolvedTarget = resolveSessionRecallTarget(sessionId, indexPath);
      if (!resolvedTarget.resolved) {
        throw new Error(resolvedTarget.error ?? "Unable to resolve session id.");
      }

      const startingAnswer = getStartingSessionAnswer(resolvedTarget.resolved.sessionPath);
      if (startingAnswer) {
        const details: SessionRecallResultDetails = {
          answer: startingAnswer,
          relevantFiles: [],
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
                formatSessionRecallHeader(
                  resolvedTarget.resolved.sessionId,
                  resolvedTarget.resolved.sessionName,
                  question,
                ),
                startingAnswer,
              ].join("\n\n"),
            },
          ],
          details,
          structuredContent: formatSessionRecallOutput(details),
        };
      }

      const progressDetails: SessionRecallProgressDetails = {
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
            text: formatSessionRecallHeader(
              resolvedTarget.resolved.sessionId,
              resolvedTarget.resolved.sessionName,
              question,
            ),
          },
        ],
        details: progressDetails,
      });

      const modelRuntime = deps.getModelRuntime(ctx.modelRegistry);
      const agentResult = await runSessionRecallAgent({
        ctx,
        modelRuntime,
        target: resolvedTarget.resolved,
        question,
        indexPath,
        recallSettings: settings.recall,
        thinkingLevel: pi.getThinkingLevel(),
        signal,
      });

      const answer = agentResult?.answer || "Could not determine an answer from the session.";
      const relevantFiles = agentResult?.relevantFiles ?? [];

      const details: SessionRecallResultDetails = {
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
              formatSessionRecallHeader(
                resolvedTarget.resolved.sessionId,
                resolvedTarget.resolved.sessionName,
                question,
              ),
              formatSessionRecallAnswer(answer, relevantFiles, agentResult?.debugSessionPath),
            ].join("\n\n"),
          },
        ],
        details,
        structuredContent: formatSessionRecallOutput(details),
      };
    },
    renderCall: renderToolNameCall("session_recall"),
    renderResult: renderSessionRecallResult,
  });
}

function getStartingSessionAnswer(sessionPath: string): string | undefined {
  try {
    if (isSessionStarting(SessionManager.open(sessionPath).getBranch())) {
      return "This session is still starting: a handoff is in progress and it has not received its kickoff. Retry once the session is no longer starting.";
    }
  } catch {
    // The navigation agent preserves the existing failure behavior for unreadable sessions.
  }
  return undefined;
}

function resolveSessionRecallTarget(
  sessionId: string,
  indexPath: string,
): {
  resolved?: SessionLineageRow | undefined;
  error?: string | undefined;
} {
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

function formatSessionRecallOutput(details: SessionRecallResultDetails): SessionRecallOutput {
  return {
    session_id: details.sessionId,
    session_name: details.sessionName,
    answer: details.answer,
    relevant_files: details.relevantFiles,
  };
}

function formatSessionRecallHeader(
  sessionId: string,
  sessionName: string,
  question: string,
): string {
  return [
    `session: ${sessionId}`,
    `title: ${sessionName || "[unnamed]"}`,
    `question: ${question}`,
  ].join("\n");
}

function formatSessionRecallAnswer(
  answer: string,
  relevantFiles: SessionRecallRelevantFile[],
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
