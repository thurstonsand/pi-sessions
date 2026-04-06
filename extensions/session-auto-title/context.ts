import {
  buildSessionContext,
  convertToLlm,
  type SessionEntry,
  serializeConversation,
} from "@mariozechner/pi-coding-agent";

export interface AutoTitleContext {
  cwd: string | undefined;
  currentTitle: string | undefined;
  conversationText: string;
  userTurnCount: number;
  assistantTurnCount: number;
}

export function buildAutoTitleContext(
  entries: SessionEntry[],
  leafId: string | null,
  options?: { cwd?: string; currentTitle?: string | undefined },
): AutoTitleContext {
  const sessionContext = buildSessionContext(entries, leafId);
  const conversationText = serializeConversation(convertToLlm(sessionContext.messages));

  let userTurnCount = 0;
  let assistantTurnCount = 0;
  for (const message of sessionContext.messages) {
    if (message.role === "user") {
      userTurnCount += 1;
    } else if (message.role === "assistant") {
      assistantTurnCount += 1;
    }
  }

  return {
    cwd: options?.cwd,
    currentTitle: options?.currentTitle,
    conversationText,
    userTurnCount,
    assistantTurnCount,
  };
}
