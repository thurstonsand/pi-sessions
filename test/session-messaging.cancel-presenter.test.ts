import { describe, expect, it, vi } from "vitest";
import {
  buildCancelSessionModelText,
  buildCancelSessionUserError,
  buildCancelSessionUserText,
  buildDeadSessionError,
  buildUnknownCancellationError,
} from "../extensions/session-messaging/pi/cancel-session-presenter.ts";
import type { CancelSessionToolDetails } from "../extensions/session-messaging/pi/message-contracts.ts";
import { createSessionCancelTool } from "../extensions/session-messaging/pi/tools.ts";

const theme = {
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
};

const target = {
  sessionId: "019f8010-39c1-7a6e-888a-11a8a0ab9442",
  sessionName: "Probe live cancellation",
};

function managed(state: string): CancelSessionToolDetails {
  return { kind: "managed", accepted: true, target, state };
}

describe("cancel-session presentation", () => {
  it.each([
    ["stopped", 'Stopped subagent "Probe live cancellation".'],
    [
      "stopping",
      'Stop requested for subagent "Probe live cancellation"; it is still shutting down.',
    ],
    ["active", 'Stop requested for subagent "Probe live cancellation"; it is still shutting down.'],
    ["completed", 'Subagent "Probe live cancellation" already completed.'],
  ])("presents managed %s state in plain language", (state, expected) => {
    const details = managed(state);

    expect(buildCancelSessionUserText(details)).toBe(expected);
    expect(buildCancelSessionModelText(details)).toBe(
      expected.replace(
        '"Probe live cancellation"',
        '"Probe live cancellation" (session: 019f8010-39c1-7a6e-888a-11a8a0ab9442)',
      ),
    );
  });

  it("keeps dead-target context model-visible but out of collapsed user copy", () => {
    const error = buildDeadSessionError(target.sessionId);

    expect(error).toBe(
      "No running session found: 019f8010-39c1-7a6e-888a-11a8a0ab9442.\nThe target is not an owned subagent and has no broker-live process to cancel.",
    );
    expect(buildCancelSessionUserError(error, false)).toBe(
      "No running session found: 019f8010-39c1-7a6e-888a-11a8a0ab9442.",
    );
  });

  it("shows an unknown-state error's session id only when expanded", () => {
    const error = buildUnknownCancellationError(target);

    expect(buildCancelSessionUserError(error, false)).toBe(
      'Could not confirm cancellation of subagent "Probe live cancellation".',
    );
    expect(buildCancelSessionUserError(error, true)).toBe(
      'Could not confirm cancellation of subagent "Probe live cancellation".\nsession 019f8010-39c1-7a6e-888a-11a8a0ab9442',
    );
  });

  it("renders the title collapsed and full session id expanded", () => {
    const tool = createSessionCancelTool({ cancelSession: vi.fn() } as never) as {
      renderResult(
        result: unknown,
        options: unknown,
        theme: unknown,
        context: unknown,
      ): { render(width: number): string[] };
    };
    const details = managed("stopped");
    const result = {
      content: [{ type: "text", text: buildCancelSessionModelText(details) }],
      details,
    };

    const collapsed = tool
      .renderResult(result, { expanded: false, isPartial: false }, theme, {
        args: { session: target.sessionId },
        expanded: false,
        isError: false,
      })
      .render(100)
      .map((line) => line.trimEnd())
      .join("\n");
    const expanded = tool
      .renderResult(result, { expanded: true, isPartial: false }, theme, {
        args: { session: target.sessionId },
        expanded: true,
        isError: false,
      })
      .render(100)
      .map((line) => line.trimEnd())
      .join("\n");

    expect(collapsed).toBe('Stopped subagent "Probe live cancellation".');
    expect(collapsed).not.toContain(target.sessionId);
    expect(expanded).toBe(
      `Stopped subagent "Probe live cancellation".\nsession ${target.sessionId}`,
    );
  });
});
