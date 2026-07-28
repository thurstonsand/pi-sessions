import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, UserMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getDefaultAutoTitleRunsDir } from "../shared/settings.ts";
import type { AutoTitleTrigger } from "./state.ts";

export const AUTO_TITLE_RUN_REQUEST_CUSTOM_TYPE = "pi-sessions.auto-title-request";
export const AUTO_TITLE_RUN_FAILURE_CUSTOM_TYPE = "pi-sessions.auto-title-failure";

export interface AutoTitleRunRequest {
  cwd: string;
  model: Model<Api>;
  trigger: AutoTitleTrigger;
  systemPrompt: string;
  tokenBudget: number;
  thinkingLevel: ThinkingLevel | undefined;
  message: UserMessage;
}

export interface AutoTitleRun {
  sessionPath: string | undefined;
  recordResponse(response: AssistantMessage): void;
  recordFailure(message: string): void;
}

/** Records one auto-title request as a standalone Pi session so the exact prompt can be replayed. */
export function startAutoTitleRun(request: AutoTitleRunRequest): AutoTitleRun {
  const sessionManager = SessionManager.create(request.cwd, getDefaultAutoTitleRunsDir());
  sessionManager.appendSessionInfo(`auto-title (${request.trigger})`);
  sessionManager.appendModelChange(request.model.provider, request.model.id);
  if (request.thinkingLevel) {
    sessionManager.appendThinkingLevelChange(request.thinkingLevel);
  }
  sessionManager.appendCustomEntry(AUTO_TITLE_RUN_REQUEST_CUSTOM_TYPE, {
    trigger: request.trigger,
    systemPrompt: request.systemPrompt,
    tokenBudget: request.tokenBudget,
  });
  sessionManager.appendMessage(request.message);

  return {
    sessionPath: sessionManager.getSessionFile(),
    recordResponse(response) {
      sessionManager.appendMessage(response);
    },
    recordFailure(message) {
      sessionManager.appendCustomEntry(AUTO_TITLE_RUN_FAILURE_CUSTOM_TYPE, { message });
    },
  };
}
