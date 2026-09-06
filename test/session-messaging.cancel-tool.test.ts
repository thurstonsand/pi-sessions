import { describe, expect, it, vi } from "vitest";
import {
  createSessionCancelTool,
  type SessionCancelRole,
} from "../extensions/session-messaging/pi/tools.ts";

const ownerSessionId = "11111111-1234-1234-1234-123456789abc";
const siblingSessionId = "22222222-1234-1234-1234-123456789abc";

function createTool(
  role: SessionCancelRole,
  options: { getParentSessionId?: () => string | undefined } = {},
) {
  const cancelSession = vi.fn(async (sessionId: string) => ({
    kind: "transport" as const,
    delivered: true as const,
    cancelId: "cancel-1",
    target: { sessionId },
  }));
  const tool = createSessionCancelTool(
    { cancelSession },
    {
      role,
      ...(options.getParentSessionId ? { getParentSessionId: options.getParentSessionId } : {}),
    },
  );
  return { cancelSession, tool };
}

describe("session_cancel wording", () => {
  it("carries a single guideline for a plain session", () => {
    const { tool } = createTool({ kind: "plain" });

    expect(tool.description).toBe("Cancel another running pi session");
    expect(tool.promptSnippet).toBe("Cancel another running pi session");
    expect(tool.promptGuidelines).toEqual(["Only cancel a user session when the user directs it."]);
  });

  it("warns a subagent off its parent", () => {
    const { tool } = createTool({ kind: "subagent" });

    expect(tool.description).toBe("Cancel another running pi session");
    expect(tool.promptSnippet).toBe("Cancel another running pi session");
    expect(tool.promptGuidelines).toEqual([
      "Only cancel a user session when the user directs it.",
      "Never cancel your parent session; it is waiting on your report.",
    ]);
  });
});

describe("session_cancel subagent targeting", () => {
  it("refuses to cancel the owning parent", async () => {
    const { cancelSession, tool } = createTool(
      { kind: "subagent" },
      { getParentSessionId: () => ownerSessionId },
    );

    await expect(
      tool.execute("call-1", { session: ownerSessionId }, undefined, undefined, {} as never),
    ).rejects.toThrow("The parent session cannot be cancelled. It is waiting on your report.");
    expect(cancelSession).not.toHaveBeenCalled();
  });

  it("cancels a sibling subagent", async () => {
    const { cancelSession, tool } = createTool(
      { kind: "subagent" },
      { getParentSessionId: () => ownerSessionId },
    );

    const result = await tool.execute(
      "call-1",
      { session: siblingSessionId },
      undefined,
      undefined,
      {} as never,
    );

    expect(cancelSession).toHaveBeenCalledWith(siblingSessionId);
    expect((result.content[0] as { text: string }).text).toContain(siblingSessionId);
  });

  it("refuses the parent resolved after construction, whatever wording it was built with", async () => {
    let parentSessionId: string | undefined;
    const { cancelSession, tool } = createTool(
      { kind: "plain" },
      { getParentSessionId: () => parentSessionId },
    );

    await tool.execute("call-1", { session: ownerSessionId }, undefined, undefined, {} as never);
    expect(cancelSession).toHaveBeenCalledOnce();

    // A rewind onto the subagent branch makes this session a subagent without re-registration.
    parentSessionId = ownerSessionId;
    cancelSession.mockClear();

    await expect(
      tool.execute("call-2", { session: ownerSessionId }, undefined, undefined, {} as never),
    ).rejects.toThrow("The parent session cannot be cancelled. It is waiting on your report.");
    expect(cancelSession).not.toHaveBeenCalled();
  });
});
