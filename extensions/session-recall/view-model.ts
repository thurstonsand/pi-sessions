import { normalizeOptionalText } from "../shared/text.ts";
import type { SessionRecallResultDetails } from "./tool-contract.ts";

export interface SessionRecallViewModel {
  sessionId: string;
  sessionName?: string | undefined;
  question: string;
  answer: string;
}

export function buildSessionRecallView(
  details: SessionRecallResultDetails,
): SessionRecallViewModel {
  return {
    sessionId: details.sessionId.trim(),
    sessionName: normalizeOptionalText(details.sessionName),
    question: details.question.trim(),
    answer: details.answer.trim(),
  };
}
