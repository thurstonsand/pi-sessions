import { describe, expect, it } from "vitest";
import { buildIncomingMessageView } from "../extensions/session-messaging/pi/incoming-message-view-model.ts";

describe("incoming-message view model", () => {
  it("normalizes received entry data without presentation concerns", () => {
    expect(
      buildIncomingMessageView({
        messageId: "msg-1",
        source: { sessionId: "source-1", sessionName: " Source Session " },
        target: { sessionId: "target-1" },
        body: "Message body.",
        sentAt: "2026-01-01T00:00:00.000Z",
        receivedAt: "2026-01-01T00:00:01.000Z",
        requestResponse: true,
        relation: "parent",
      }),
    ).toEqual({
      sourceSessionId: "source-1",
      sourceSessionName: "Source Session",
      relation: "parent",
      requestResponse: true,
      body: "Message body.",
    });
  });
});
