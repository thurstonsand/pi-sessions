import type { AutoTitleContext } from "./context.js";
import type { AutoTitleTrigger } from "./state.js";

const AUTO_TITLE_CHAR_MAX = 120;

export const AUTO_TITLE_SYSTEM_PROMPT = `You generate concrete coding session titles from the conversation provided.

Return title text only.

Rules:
- Prefer 3-15 words.
- Maximum 120 characters.
- Use the full conversation, while letting the most recent work refine the title when needed.
- Describe the current task, bug, feature, or investigation on the active branch.
- Mention specific subsystem or file only when it improves clarity.
- No quotes, markdown, emojis, prefixes, or explanations.
- No trailing punctuation.
- Avoid generic titles like Coding help or Working on project.`;

export function buildAutoTitlePrompt(context: AutoTitleContext, trigger: AutoTitleTrigger): string {
  const sections = [
    ["## Trigger", trigger],
    ["## Current Title", context.currentTitle ?? "(none)"],
    ["## Counts", formatCounts(context)],
    ["## Conversation", context.conversationText || "(none)"],
  ];

  if (context.cwd) {
    sections.unshift(["## Cwd", context.cwd]);
  }

  return sections.map(([heading, body]) => `${heading}\n${body}`).join("\n\n");
}

export function normalizeGeneratedAutoTitle(value: string): string | undefined {
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

function formatCounts(context: AutoTitleContext): string {
  return [
    `user_turns: ${context.userTurnCount}`,
    `assistant_turns: ${context.assistantTurnCount}`,
  ].join("\n");
}
