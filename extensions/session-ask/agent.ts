import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import { type AskSettings, getDefaultSessionAskRunsDir } from "../shared/settings.ts";
import {
  buildSessionMap,
  buildSessionMetadata,
  findBranchesForEntry,
  findSpanForEntry,
  loadSessionNavigationData,
  readEntriesFromEntry,
  readProjectAgentsMd,
  type SessionNavigationData,
  type SessionReadResult,
  type SessionSearchHitBranch,
  type SessionSearchHitSpan,
} from "./navigate.ts";

const SEARCH_SESSION_TOOL_NAME = "session_search";
const SESSION_READ_TOOL_NAME = "session_read";
const PROVIDE_RESULTS_TOOL_NAME = "provide_results";
const SESSION_ASK_AGENT_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  SEARCH_SESSION_TOOL_NAME,
  SESSION_READ_TOOL_NAME,
  PROVIDE_RESULTS_TOOL_NAME,
];
const MAX_SESSION_ASK_ATTEMPTS = 3;

const SESSION_ASK_NAVIGATION_SYSTEM_PROMPT = `You are an evidence-first session analyst. Your job is to inspect one Pi session, gather the relevant context from its spans and entries, and answer the question below only after verifying the original evidence.

Rules:
- Do not stop at the first relevant hit. Check newer messages that revise, supersede, revert, or contradict it.
- Tool calls record attempted actions, not outcomes. Check tool results before treating an action as successful.
- Keep session history and current repo state separate. The repo may have changed. Say "the session says" and "the current repo confirms/contradicts" when both matter.
- Compaction summaries are navigation aids, not answer sources. Use original entries for exact requirements, decisions, commands, and outcomes whenever they exist.
- Call provide_results exactly once with the answer.`;

const SEARCH_SESSION_PARAMETERS = Type.Object({
  query: Type.String({
    description:
      "Use plain adjacent terms for normal search within the target session. Supports quoted phrases, AND/OR/NOT, parentheses, and -term negation when matching needs to be stricter.",
  }),
  limit: Type.Optional(Type.Number({ description: "Maximum hits to return." })),
});

const SESSION_READ_PARAMETERS = Type.Object({
  entryId: Type.String({ description: "Entry id to start from." }),
  pathTarget: Type.Optional(
    Type.String({
      description: "Returns entries from `entryId` through this entryId along that path.",
    }),
  ),
  before: Type.Optional(Type.Number({ description: "Entries before entryId to include." })),
  after: Type.Optional(Type.Number({ description: "Entries after entryId to include." })),
  body: Type.Optional(
    Type.Union([Type.Literal("preview"), Type.Literal("full")], {
      description:
        '"preview" (default) truncates tool calls, enabling safer larger-range queries. When a particular entry is of interest, read a targeted, small range with "full" to get the entire entry.',
    }),
  ),
});

const PROVIDE_RESULTS_PARAMETERS = Type.Object({
  answer: Type.String({
    description: "The final answer to return to the caller, in markdown.",
  }),
  relevantFiles: Type.Optional(
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

type SearchSessionParams = Static<typeof SEARCH_SESSION_PARAMETERS>;
type SessionReadParams = Static<typeof SESSION_READ_PARAMETERS>;
type ProvideResultsArgs = Static<typeof PROVIDE_RESULTS_PARAMETERS>;

interface SearchSessionToolDetails {
  hits: SessionAskSearchHit[];
  searchUnavailable: boolean;
}

interface SessionAskSearchHit {
  entryId: string;
  sourceKind: string;
  timestamp: string;
  size: number;
  snippet: string;
  branch: SessionSearchHitBranch[];
  span?: SessionSearchHitSpan | undefined;
}

export interface SessionAskAgentResult {
  answer: string;
  relevantFiles: Array<{ path: string; reason: string }>;
  debugSessionPath?: string | undefined;
}

export async function runSessionAskAgent(params: {
  ctx: ExtensionContext;
  target: SessionLineageRow;
  question: string;
  indexPath: string;
  askSettings: AskSettings | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  signal?: AbortSignal | undefined;
}): Promise<SessionAskAgentResult | undefined> {
  params.signal?.throwIfAborted();
  const navigationData = loadSessionNavigationData(params.target.sessionPath);
  const configured = params.askSettings?.model
    ? resolveAuthenticatedModel({
        modelRegistry: params.ctx.modelRegistry,
        modelPattern: params.askSettings.model,
      })
    : undefined;
  const model = (configured?.ok ? configured.model : undefined) ?? params.ctx.model;
  if (!model) {
    throw new Error("No active model is available for session_ask.");
  }
  const configuredThinkingLevel = configured?.ok ? configured.thinkingLevel : undefined;

  let capturedArguments: ProvideResultsArgs | undefined;
  const searchSessionTool = defineTool({
    name: SEARCH_SESSION_TOOL_NAME,
    label: "Search target session",
    description: "Search the target session and return ranked hits.",
    promptSnippet: "Search target session",
    promptGuidelines: [
      "Results are sorted best-first by relevance.",
      "Use returned entryId values with session_read to inspect full session context.",
    ],
    parameters: SEARCH_SESSION_PARAMETERS,
    execute: async (_toolCallId, toolParams: SearchSessionParams) => {
      const hits = withSessionIndex(params.indexPath, { mode: "read", required: false }, ({ db }) =>
        searchSessionChunks(db, {
          sessionIds: [params.target.sessionId],
          query: toolParams.query,
          limit: toolParams.limit ?? 50,
        }),
      );

      if (!hits) {
        const noHits: SessionAskSearchHit[] = [];
        const searchUnavailable: boolean = true;
        return {
          content: [
            {
              type: "text" as const,
              text: "Session search is unavailable because the session index could not be opened. Navigate with the Session Map and session_read instead.",
            },
          ],
          details: { hits: noHits, searchUnavailable } as SearchSessionToolDetails,
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
            text: formatSearchSessionHits(formattedHits),
          },
        ],
        details: {
          hits: formattedHits,
          searchUnavailable: false as boolean,
        } as SearchSessionToolDetails,
      };
    },
  });

  const sessionReadTool = defineTool({
    name: SESSION_READ_TOOL_NAME,
    label: "Read target session entries",
    description: "Read full entry content from the target session, starting at an entry id.",
    promptSnippet: "Read target session entries",
    promptGuidelines: [
      "Use either pathTarget or before/after; they are mutually exclusive.",
      "Read an entire span by using the span's end id as the pathTarget.",
      "Read across spans by using a later connected span's end id as the pathTarget.",
      "Combine before and/or after for local context around a specific entryId; must stay within the containing span.",
    ],
    parameters: SESSION_READ_PARAMETERS,
    execute: async (_toolCallId, toolParams: SessionReadParams) => {
      const readResult = readEntriesFromEntry(navigationData, {
        entryId: toolParams.entryId,
        before: toolParams.before,
        after: toolParams.after,
        pathTargetEntryId: toolParams.pathTarget,
        body: toolParams.body,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: formatSessionReadResult(readResult),
          },
        ],
        details: readResult,
      };
    },
  });

  const provideResultsTool = defineTool({
    name: PROVIDE_RESULTS_TOOL_NAME,
    label: "Provide session ask result",
    description: "Return the final answer for session_ask.",
    promptSnippet: "Provide session ask result",
    promptGuidelines: [
      "Call provide_results exactly once when you are ready to answer. It is the final tool call and ends the session_ask sub-agent turn.",
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
    appendSystemPromptOverride: (base) => [...base, SESSION_ASK_NAVIGATION_SYSTEM_PROMPT],
  });
  params.signal?.throwIfAborted();
  await resourceLoader.reload();
  params.signal?.throwIfAborted();

  const thinkingLevel =
    params.askSettings?.thinkingLevel ?? configuredThinkingLevel ?? params.thinkingLevel;
  const sessionManager = params.askSettings?.persistRuns
    ? SessionManager.create(cwd, getDefaultSessionAskRunsDir())
    : SessionManager.inMemory(cwd);
  const debugSessionPath = params.askSettings?.persistRuns
    ? sessionManager.getSessionFile()
    : undefined;
  const { session } = await createAgentSession({
    cwd,
    model,
    modelRegistry: params.ctx.modelRegistry,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    tools: SESSION_ASK_AGENT_TOOLS,
    customTools: [searchSessionTool, sessionReadTool, provideResultsTool],
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

    for (let attempt = 1; attempt <= MAX_SESSION_ASK_ATTEMPTS; attempt += 1) {
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
    relevantFiles: capturedArguments.relevantFiles ?? [],
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

function formatSearchSessionHits(hits: SessionAskSearchHit[]): string {
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

function formatSearchHitSpan(span: SessionSearchHitSpan | undefined): string {
  if (!span) {
    return "none";
  }

  return `(${span.startsAtEntryId}, ${span.endsAtEntryId})${span.isActive ? " on_active_branch" : ""}; before ${span.entriesBefore}; after ${span.entriesAfter}`;
}

function formatSessionReadResult(result: SessionReadResult): string {
  const sections = result.entries.map((entry) =>
    [
      `### ${entry.entryId}`,
      `type: ${entry.type}`,
      `timestamp: ${entry.timestamp}`,
      `path_target: ${entry.pathTargetEntryId}`,
      `body: ${entry.body}`,
      `size: ${entry.size}`,
      entry.truncated ? "truncated: true" : "truncated: false",
      "",
      entry.content,
    ].join("\n"),
  );

  if (result.nextEntryId) {
    sections.push(
      `Next page: call session_read with entryId ${result.nextEntryId} and pathTarget ${result.pathTargetEntryId}.`,
    );
  }

  return sections.join("\n\n");
}
