import { describe, expect, it } from "vitest";
import { buildSessionRecallPresentation } from "../extensions/session-recall/presenter.ts";

const theme = {
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
};

describe("session-recall presenter", () => {
  it("maps the view model into generic expandable content", () => {
    expect(
      buildSessionRecallPresentation(
        {
          answer: "Answer.",
          question: "Question?",
          sessionId: "12345678-1234-1234-1234-123456789abc",
          sessionName: "Session title",
        },
        theme,
      ),
    ).toEqual({
      header: "title: Session title",
      metadata: ["prompt: Question?"],
      body: { text: "Answer.", collapsedRows: 6 },
    });
  });
});
