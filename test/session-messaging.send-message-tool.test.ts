import { describe, expect, it, vi } from "vitest";
import type {
  SendMessageRequest,
  SendMessageResult,
} from "../extensions/session-messaging/pi/service.ts";
import {
  createSessionSendMessageTool,
  type SessionSendMessageRole,
} from "../extensions/session-messaging/pi/tools.ts";

const ownerSessionId = "11111111-1234-1234-1234-123456789abc";
const siblingSessionId = "22222222-1234-1234-1234-123456789abc";

function createTool(
  role: SessionSendMessageRole,
  options: {
    getParentSessionId?: () => string | undefined;
    sendMessage?: (request: SendMessageRequest) => Promise<SendMessageResult>;
  } = {},
) {
  const sendMessage =
    options.sendMessage ??
    (async () => ({
      delivered: true,
      messageId: "message-1",
      target: { sessionId: siblingSessionId },
    }));
  const service = { sendMessage: vi.fn(sendMessage) };
  const tool = createSessionSendMessageTool(service, {
    role,
    getCachedRelationTo: vi.fn(() => undefined),
    ...(options.getParentSessionId ? { getParentSessionId: options.getParentSessionId } : {}),
  });
  return { service, tool };
}

describe("session_send_message wording", () => {
  it("describes a plain messaging session", () => {
    const { tool } = createTool({ kind: "plain" });

    expect(tool.description).toBe("Send a message to another live pi session.");
    expect(tool.promptSnippet).toBe("Send a message to another live pi session");
    expect(tool.promptGuidelines).toEqual([
      "Use session_reachable to list live sessions and find the target.",
    ]);
  });

  it("describes a session that can wake owned subagents", () => {
    const { tool } = createTool({ kind: "wakeCapable" });

    expect(tool.description).toBe("Send a message to another live pi session or a subagent.");
    expect(tool.promptSnippet).toBe("Send a message to another pi session or a subagent");
    expect(tool.promptGuidelines).toEqual([
      "Use session_reachable to discover live sessions and owned subagents.",
    ]);
  });

  it("points a subagent at submit_task_report for its parent", () => {
    const { tool } = createTool({ kind: "subagent" });

    expect(tool.description).toBe("Send a message to another subagent.");
    expect(tool.promptSnippet).toBe("Send a message to another subagent");
    expect(tool.promptGuidelines).toEqual([
      "Use session_reachable to discover reachable subagents.",
      "Report to your parent with submit_task_report; it cannot be reached with session_send_message.",
    ]);
  });
});

describe("session_send_message subagent targeting", () => {
  it("refuses to message the owning parent", async () => {
    const { service, tool } = createTool(
      { kind: "subagent" },
      { getParentSessionId: () => ownerSessionId },
    );

    await expect(
      tool.execute(
        "call-1",
        { session: ownerSessionId, message: "Here is my report." },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("The parent session cannot be messaged. Use submit_task_report.");
    expect(service.sendMessage).not.toHaveBeenCalled();
  });

  it("delivers to a sibling subagent", async () => {
    const { service, tool } = createTool(
      { kind: "subagent" },
      { getParentSessionId: () => ownerSessionId },
    );

    const result = await tool.execute(
      "call-1",
      { session: siblingSessionId, message: "Taking the parser." },
      undefined,
      undefined,
      {} as never,
    );

    expect(service.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ target: siblingSessionId, body: "Taking the parser." }),
    );
    expect((result.content[0] as { text: string }).text).toContain(siblingSessionId);
  });

  it("refuses the parent resolved after construction, whatever wording it was built with", async () => {
    let parentSessionId: string | undefined;
    const { service, tool } = createTool(
      { kind: "wakeCapable" },
      { getParentSessionId: () => parentSessionId },
    );

    await tool.execute(
      "call-1",
      { session: ownerSessionId, message: "Before the rewind." },
      undefined,
      undefined,
      {} as never,
    );
    expect(service.sendMessage).toHaveBeenCalledOnce();

    // A rewind onto the subagent branch makes this session a subagent without re-registration.
    parentSessionId = ownerSessionId;
    service.sendMessage.mockClear();

    await expect(
      tool.execute(
        "call-2",
        { session: ownerSessionId, message: "After the rewind." },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("The parent session cannot be messaged. Use submit_task_report.");
    expect(service.sendMessage).not.toHaveBeenCalled();
  });
});
