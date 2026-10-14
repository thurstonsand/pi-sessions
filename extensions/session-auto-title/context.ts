import {
  buildSessionContext,
  convertToLlm,
  type SessionEntry,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";

export interface AutoTitleContext {
  sessionId: string;
  cwd: string | undefined;
  currentTitle: string | undefined;
  conversationText: string;
  userTurnCount: number;
  assistantTurnCount: number;
}

export function buildAutoTitleContext(
  entries: SessionEntry[],
  leafId: string | null,
  options: { sessionId: string; cwd: string | undefined; currentTitle: string | undefined },
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
    sessionId: options.sessionId,
    cwd: options.cwd,
    currentTitle: options.currentTitle,
    conversationText,
    userTurnCount,
    assistantTurnCount,
  };
}
