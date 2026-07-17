import { describe, expect, it } from "vitest";
import {
  buildDeliveredMessageView,
  buildSendingMessageView,
} from "../extensions/session-messaging/pi/send-message-view-model.ts";

describe("send-message view model", () => {
  it("normalizes partial call arguments without presentation concerns", () => {
    expect(
      buildSendingMessageView(
        {
          session: " target-1 ",
          message: "partial message",
          requestResponse: true,
        },
        "child",
      ),
    ).toEqual({
      status: "sending",
      targetSessionId: "target-1",
      relation: "child",
      requestResponse: true,
      body: "partial message",
    });
  });

  it("builds the completed view from durable result details", () => {
    expect(
      buildDeliveredMessageView(
        { message: "  Delivered body.  ", requestResponse: true },
        {
          delivered: true,
          messageId: "msg-1",
          target: { sessionId: "target-1", sessionName: "Target Session" },
          relation: "child",
        },
      ),
    ).toEqual({
      status: "delivered",
      targetSessionId: "target-1",
      targetSessionName: "Target Session",
      relation: "child",
      requestResponse: true,
      body: "Delivered body.",
    });
  });
});
