import { normalizeOptionalText } from "../shared/text.ts";
import type { SessionAskResultDetails } from "./tool-contract.ts";

export interface SessionAskViewModel {
  sessionId: string;
  sessionName?: string | undefined;
  question: string;
  answer: string;
}

export function buildSessionAskView(details: SessionAskResultDetails): SessionAskViewModel {
  return {
    sessionId: details.sessionId.trim(),
    sessionName: normalizeOptionalText(details.sessionName),
    question: details.question.trim(),
    answer: details.answer.trim(),
  };
}
