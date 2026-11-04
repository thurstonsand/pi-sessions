import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { resolveAuthenticatedModel } from "../shared/model-resolution.ts";
import {
  type SessionLineageRow,
  searchSessionChunks,
  withSessionIndex,
} from "../shared/session-index/index.ts";
import { getDefaultSessionRecallRunsDir, type RecallSettings } from "../shared/settings.ts";
import {
  buildSessionMap,
  buildSessionMetadata,
  findBranchesForEntry,
  findSpanForEntry,
  loadSessionNavigationData,
  type RecallReadResult,
  type RecallSearchHitBranch,
  type RecallSearchHitSpan,
  readEntriesFromEntry,
  readProjectAgentsMd,
  type SessionNavigationData,
} from "./navigate.ts";

const RECALL_SEARCH_TOOL_NAME = "recall_search";
const RECALL_READ_TOOL_NAME = "recall_read";
const PROVIDE_RESULTS_TOOL_NAME = "provide_results";
const SESSION_RECALL_AGENT_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  RECALL_SEARCH_TOOL_NAME,
  RECALL_READ_TOOL_NAME,
  PROVIDE_RESULTS_TOOL_NAME,
];
const MAX_SESSION_RECALL_ATTEMPTS = 3;

const SESSION_RECALL_NAVIGATION_SYSTEM_PROMPT = `You are an evidence-first session analyst. Your job is to inspect one Pi session, gather the relevant context from its spans and entries, and answer the question below only after verifying the original evidence.

Rules:
- Do not stop at the first relevant hit. Check newer messages that revise, supersede, revert, or contradict it.
- Tool calls record attempted actions, not outcomes. Check tool results before treating an action as successful.
- Keep session history and current repo state separate. The repo may have changed. Say "the session says" and "the current repo confirms/contradicts" when both matter.
- Compaction summaries are navigation aids, not answer sources. Use original entries for exact requirements, decisions, commands, and outcomes whenever they exist.
- Call provide_results exactly once with the answer.`;

const RECALL_SEARCH_PARAMETERS = Type.Object({
  query: Type.String({
    description:
      "Use plain adjacent terms for normal search within the target session. Supports quoted phrases, AND/OR/NOT, parentheses, and -term negation when matching needs to be stricter.",
  }),
  limit: Type.Optional(Type.Number({ description: "Maximum hits to return." })),
});

const RECALL_READ_PARAMETERS = Type.Object({
  entry_id: Type.String({ description: "Entry id to start from." }),
  to: Type.Optional(
    Type.String({
      description: "Returns entries from `entry_id` through this entry id along that path.",
    }),
  ),
  before: Type.Optional(Type.Number({ description: "Entries before entry_id to include." })),
  after: Type.Optional(Type.Number({ description: "Entries after entry_id to include." })),
  tool_output: Type.Optional(
    Type.Union([Type.Literal("trimmed"), Type.Literal("whole")], {
      description:
        '"trimmed" (default) cuts tool calls and their results short, enabling safer larger-range queries. When a particular entry is of interest, read a targeted, small range with "whole" to get the entire entry.',
    }),
  ),
});

const PROVIDE_RESULTS_PARAMETERS = Type.Object({
  answer: Type.String({
    description: "The final answer to return to the caller, in markdown.",
  }),
  relevant_files: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String({
          description: "Absolute path to a file that matters to the answer.",
        }),
        reason: Type.String({
          description: "Why this file matters to the answer.",
        }),
      }),
    ),
  ),
});

type RecallSearchParams = Static<typeof RECALL_SEARCH_PARAMETERS>;
type RecallReadParams = Static<typeof RECALL_READ_PARAMETERS>;
type ProvideResultsArgs = Static<typeof PROVIDE_RESULTS_PARAMETERS>;

interface RecallSearchToolDetails {
  hits: SessionRecallSearchHit[];
  searchUnavailable: boolean;
}

interface SessionRecallSearchHit {
  entryId: string;
  sourceKind: string;
  timestamp: string;
  size: number;
  snippet: string;
  branch: RecallSearchHitBranch[];
  span?: RecallSearchHitSpan | undefined;
}

export interface SessionRecallAgentResult {
  answer: string;
  relevantFiles: Array<{ path: string; reason: string }>;
  debugSessionPath?: string | undefined;
}

export async function runSessionRecallAgent(params: {
  ctx: ExtensionContext;
  modelRuntime: ModelRuntime;
  target: SessionLineageRow;
  question: string;
  indexPath: string;
  recallSettings: RecallSettings | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  signal?: AbortSignal | undefined;
}): Promise<SessionRecallAgentResult | undefined> {
  params.signal?.throwIfAborted();
  const navigationData = loadSessionNavigationData(params.target.sessionPath);
  const configured = params.recallSettings?.model
    ? resolveAuthenticatedModel({
        modelRuntime: params.modelRuntime,
        modelPattern: params.recallSettings.model,
      })
    : undefined;
  const model = (configured?.ok ? configured.model : undefined) ?? params.ctx.model;
  if (!model) {
    throw new Error("No active model is available for session_recall.");
  }
  const configuredThinkingLevel = configured?.ok ? configured.thinkingLevel : undefined;

  let capturedArguments: ProvideResultsArgs | undefined;
  const recallSearchTool = defineTool({
    name: RECALL_SEARCH_TOOL_NAME,
    label: "Search target session",
    description: "Search the target session and return ranked hits.",
    promptSnippet: "Search target session",
    promptGuidelines: [
      "Results are sorted best-first by relevance.",
      "Pass a hit's entry id as recall_read's entry_id to inspect full session context.",
    ],
    parameters: RECALL_SEARCH_PARAMETERS,
    execute: async (_toolCallId, toolParams: RecallSearchParams) => {
      const hits = withSessionIndex(params.indexPath, { mode: "read", required: false }, ({ db }) =>
        searchSessionChunks(db, {
          sessionIds: [params.target.sessionId],
          query: toolParams.query,
          limit: toolParams.limit ?? 50,
        }),
      );

      if (!hits) {
        const noHits: SessionRecallSearchHit[] = [];
        const searchUnavailable: boolean = true;
        return {
          content: [
            {
              type: "text" as const,
              text: "Session search is unavailable because the session index could not be opened. Navigate with the Session Map and recall_read instead.",
            },
          ],
          details: { hits: noHits, searchUnavailable } as RecallSearchToolDetails,
        };
      }

      const formattedHits = hits.map((hit) => ({
        entryId: hit.entryId,
        sourceKind: hit.sourceKind,
        timestamp: hit.ts,
        size: navigationData.entrySizes.get(hit.entryId) ?? 0,
        snippet: hit.snippet,
        branch: findBranchesForEntry(navigationData, hit.entryId),
        span: findSpanForEntry(navigationData, hit.entryId),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: formatRecallSearchHits(formattedHits),
          },
        ],
        details: {
          hits: formattedHits,
          searchUnavailable: false as boolean,
        } as RecallSearchToolDetails,
      };
    },
  });

  const recallReadTool = defineTool({
    name: RECALL_READ_TOOL_NAME,
    label: "Read target session entries",
    description: "Read full entry content from the target session, starting at an entry id.",
    promptSnippet: "Read target session entries",
    promptGuidelines: [
      "Use either to or before/after; they are mutually exclusive.",
      "Read an entire span by passing the span's end id as to.",
      "Read across spans by passing a later connected span's end id as to.",
      "Combine before and/or after for local context around a specific entry_id; must stay within the containing span.",
    ],
    parameters: RECALL_READ_PARAMETERS,
    execute: async (_toolCallId, toolParams: RecallReadParams) => {
      const readResult = readEntriesFromEntry(navigationData, {
        entryId: toolParams.entry_id,
        before: toolParams.before,
        after: toolParams.after,
        toEntryId: toolParams.to,
        toolOutput: toolParams.tool_output,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: formatRecallReadResult(readResult),
          },
        ],
        details: readResult,
      };
    },
  });

  const provideResultsTool = defineTool({
    name: PROVIDE_RESULTS_TOOL_NAME,
    label: "Provide session recall result",
    description: "Return the final answer for session_recall.",
    promptSnippet: "Provide session recall result",
    promptGuidelines: [
      "Call provide_results exactly once when you are ready to answer. It is the final tool call and ends the session_recall subagent turn.",
    ],
    parameters: PROVIDE_RESULTS_PARAMETERS,
    execute: async (_toolCallId, toolParams: ProvideResultsArgs) => {
      capturedArguments = toolParams;
      return {
        content: [
          {
            type: "text" as const,
            text: "Session ask result captured. Stopping.",
          },
        ],
        details: toolParams,
        terminate: true,
      };
    },
  });

  const cwd = navigationData.header.cwd;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    appendSystemPromptOverride: (base) => [...base, SESSION_RECALL_NAVIGATION_SYSTEM_PROMPT],
  });
  params.signal?.throwIfAborted();
  await resourceLoader.reload();
  params.signal?.throwIfAborted();

  const thinkingLevel =
    params.recallSettings?.thinkingLevel ?? configuredThinkingLevel ?? params.thinkingLevel;
  const sessionManager = params.recallSettings?.persistRuns
    ? SessionManager.create(cwd, getDefaultSessionRecallRunsDir())
    : SessionManager.inMemory(cwd);
  const debugSessionPath = params.recallSettings?.persistRuns
    ? sessionManager.getSessionFile()
    : undefined;
  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime: params.modelRuntime,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    tools: SESSION_RECALL_AGENT_TOOLS,
    customTools: [recallSearchTool, recallReadTool, provideResultsTool],
    resourceLoader,
    sessionManager,
  });

  // Exactly one session.abort() runs no matter how many abort paths fire.
  let nestedAbort: Promise<void> | undefined;
  const startNestedAbort = (): void => {
    nestedAbort ??= Promise.resolve(session.abort()).catch(() => {});
  };

  try {
    params.signal?.addEventListener("abort", startNestedAbort, { once: true });
    if (params.signal?.aborted) {
      startNestedAbort();
    }

    for (let attempt = 1; attempt <= MAX_SESSION_RECALL_ATTEMPTS; attempt += 1) {
      params.signal?.throwIfAborted();
      const prompt =
        attempt === 1
          ? buildNavigationPrompt(navigationData, params.question)
          : `You did not call ${PROVIDE_RESULTS_TOOL_NAME}. Continue from your prior work and call ${PROVIDE_RESULTS_TOOL_NAME} exactly once with the final markdown answer.`;
      await session.prompt(prompt);
      params.signal?.throwIfAborted();
      if (capturedArguments) {
        break;
      }
    }
  } finally {
    params.signal?.removeEventListener("abort", startNestedAbort);
    if (nestedAbort) {
      await nestedAbort;
    }
    session.dispose();
  }

  if (!capturedArguments) {
    return undefined;
  }

  return {
    answer: capturedArguments.answer.trim(),
    relevantFiles: capturedArguments.relevant_files ?? [],
    ...(debugSessionPath ? { debugSessionPath } : {}),
  };
}

export function buildNavigationPrompt(data: SessionNavigationData, question: string): string {
  const metadata = buildSessionMetadata(data);
  const agentsMd = readProjectAgentsMd(data.header.cwd) ?? "<file not found>";

  return `## Target Session
session_id: ${metadata.sessionId}
title: ${metadata.sessionName || "[unnamed]"}
cwd: ${metadata.cwd}
started_at: ${metadata.startedAt}
modified_at: ${metadata.modifiedAt}
entry_count: ${metadata.entryCount}
message_count: ${metadata.messageCount}
span_count: ${data.spans.length}

## Session Map
${buildSessionMap(data)}

## Project AGENTS.md
\`\`\`\`md
${agentsMd}
\`\`\`\`

## Question
${question}`;
}

function formatRecallSearchHits(hits: SessionRecallSearchHit[]): string {
  if (hits.length === 0) {
    return "No matching entries found.";
  }

  return hits
    .map((hit) =>
      [
        `### ${hit.entryId}`,
        `source_kind: ${hit.sourceKind}`,
        `timestamp: ${hit.timestamp}`,
        `size: ${hit.size}`,
        `branches: ${hit.branch.map((branch) => `${branch.branchLeafId}${branch.isActive ? "*" : ""}`).join(", ") || "none"}`,
        `span: ${formatSearchHitSpan(hit.span)}`,
        "snippet:",
        "````",
        hit.snippet,
        "````",
      ].join("\n"),
    )
    .join("\n\n");
}

function formatSearchHitSpan(span: RecallSearchHitSpan | undefined): string {
  if (!span) {
    return "none";
  }

  return `(${span.startsAtEntryId}, ${span.endsAtEntryId})${span.isActive ? " on_active_branch" : ""}; before ${span.entriesBefore}; after ${span.entriesAfter}`;
}

function formatRecallReadResult(result: RecallReadResult): string {
  const sections = result.entries.map((entry) =>
    [
      `### ${entry.entryId}`,
      `type: ${entry.type}`,
      `timestamp: ${entry.timestamp}`,
      `to: ${entry.toEntryId}`,
      `tool_output: ${entry.toolOutput}`,
      `size: ${entry.size}`,
      entry.truncated ? "truncated: true" : "truncated: false",
      "",
      entry.content,
    ].join("\n"),
  );

  if (result.nextEntryId) {
    sections.push(
      `Next page: call recall_read with entry_id ${result.nextEntryId} and to ${result.toEntryId}.`,
    );
  }

  return sections.join("\n\n");
}
