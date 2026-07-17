import { describe, expect, it } from "vitest";
import {
  SESSION_ASK_PROGRESS_DETAILS_SCHEMA,
  SESSION_ASK_RESULT_DETAILS_SCHEMA,
} from "../extensions/session-ask/tool-contract.ts";
import { buildSessionAskView } from "../extensions/session-ask/view-model.ts";
import { safeParseTypeBoxValue } from "../extensions/shared/typebox.ts";

describe("session-ask view model", () => {
  it("requires the fields guaranteed by progress and completed results", () => {
    expect(
      safeParseTypeBoxValue(SESSION_ASK_PROGRESS_DETAILS_SCHEMA, {
        question: "Question?",
        sessionId: "session-1",
        sessionName: "Session title",
        sessionPath: "/tmp/session.jsonl",
      }),
    ).toBeDefined();
    expect(
      safeParseTypeBoxValue(SESSION_ASK_PROGRESS_DETAILS_SCHEMA, {
        sessionId: "session-1",
      }),
    ).toBeUndefined();
    expect(
      safeParseTypeBoxValue(SESSION_ASK_RESULT_DETAILS_SCHEMA, {
        question: "Question?",
        relevantFiles: [],
        sessionId: "session-1",
        sessionName: "Session title",
        sessionPath: "/tmp/session.jsonl",
      }),
    ).toBeUndefined();
  });

  it("normalizes durable tool details without presentation concerns", () => {
    expect(
      buildSessionAskView({
        answer: " Answer. ",
        question: " Question? ",
        relevantFiles: [],
        sessionId: "session-1",
        sessionName: " Session title ",
        sessionPath: "/tmp/session.jsonl",
      }),
    ).toEqual({
      answer: "Answer.",
      question: "Question?",
      sessionId: "session-1",
      sessionName: "Session title",
    });
  });
});
