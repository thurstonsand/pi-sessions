import { describe, expect, it, vi } from "vitest";
import type { ClipboardStatus } from "../extensions/session-handoff/launch/backend.ts";
import {
  buildLaunchReceipt,
  createHandoffLaunchReceiptRenderer,
  createLaunchReceiptComponent,
  type HandoffLaunchReceipt,
} from "../extensions/session-handoff/receipt.ts";

const theme = {
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
};

function renderReceipt(
  receipt: HandoffLaunchReceipt,
  expanded: boolean,
  clipboardStatus?: ClipboardStatus,
): string {
  return createLaunchReceiptComponent(receipt, expanded, theme, clipboardStatus)
    .render(120)
    .map((line) => line.trimEnd())
    .join("\n");
}

describe("handoff launch receipt", () => {
  it("omits matching cwd while retaining the effective model", () => {
    const receipt = buildLaunchReceipt({
      sessionId: "child-1",
      title: "Index fix",
      launch: "deferred",
      resumeCommand: "pi --session-id 'child-1'",
      targetCwd: "/repo/app",
      parentCwd: "/repo/app",
      childModel: "openai/gpt-5.4:high",
    });

    expect(receipt).toEqual({
      sessionId: "child-1",
      title: "Index fix",
      launch: "deferred",
      resumeCommand: "pi --session-id 'child-1'",
      model: "openai/gpt-5.4:high",
    });
  });

  it("includes a differing cwd and the effective model", () => {
    const receipt = buildLaunchReceipt({
      sessionId: "child-1",
      title: "Index fix",
      launch: "right",
      backend: "Ghostty",
      resumeCommand: "cd '/other' && pi --session-id 'child-1'",
      targetCwd: "/other",
      parentCwd: "/repo/app",
      childModel: "anthropic/claude-sonnet-4-5",
    });

    expect(receipt).toMatchObject({
      cwd: "/other",
      model: "anthropic/claude-sonnet-4-5",
      backend: "Ghostty",
    });
  });

  it("renders the deferred receipt with the command visible collapsed", () => {
    const receipt = buildLaunchReceipt({
      sessionId: "child-1",
      title: "Index fix",
      launch: "deferred",
      resumeCommand: "pi --session-id 'child-1'",
      targetCwd: "/other",
      parentCwd: "/repo/app",
      childModel: "openai/gpt-5.4:high",
    });

    const collapsed = renderReceipt(receipt, false);
    expect(collapsed).toContain("handoff ready Index fix");
    expect(collapsed).toContain("model openai/gpt-5.4:high");
    expect(collapsed).toContain("resume command\n pi --session-id 'child-1'");
    expect(collapsed).not.toContain("clipboard");
    expect(collapsed).not.toContain("id child-1");

    const expanded = renderReceipt(receipt, true);
    expect(expanded).toContain("id child-1");
    expect(expanded).toContain("cwd /other");
    expect(expanded).toContain("model openai/gpt-5.4:high");
    expect(expanded.indexOf("id child-1")).toBeLessThan(expanded.indexOf("resume command"));
    expect(expanded.endsWith("resume command\n pi --session-id 'child-1'")).toBe(true);
  });

  it("renders the split receipt with the command only when expanded", () => {
    const receipt = buildLaunchReceipt({
      sessionId: "child-1",
      title: "Index fix",
      launch: "right",
      backend: "Ghostty",
      resumeCommand: "pi --session-id 'child-1'",
      targetCwd: "/repo/app",
      parentCwd: "/repo/app",
      childModel: "openai/gpt-5.4:max",
    });

    const collapsed = renderReceipt(receipt, false);
    expect(collapsed).toContain("handoff launched Index fix");
    expect(collapsed).toContain("right · child-1");
    expect(collapsed).toContain("model openai/gpt-5.4:max");
    expect(collapsed).not.toContain("recovery command");

    const expanded = renderReceipt(receipt, true);
    expect(expanded).toContain("id child-1");
    expect(expanded).toContain("launched Ghostty right");
    expect(expanded).toContain("model openai/gpt-5.4:max");
    expect(expanded).toContain("recovery command\n pi --session-id 'child-1'");
  });

  it("wraps command receipts in a custom-message box", () => {
    const renderer = createHandoffLaunchReceiptRenderer(() => "copied") as unknown as (
      entry: unknown,
      options: { expanded: boolean },
      rendererTheme: typeof theme,
    ) => { render(width: number): string[] };
    const receipt = buildLaunchReceipt({
      sessionId: "child-1",
      title: "Index fix",
      launch: "deferred",
      resumeCommand: "pi --session-id 'child-1'",
      targetCwd: "/repo/app",
      parentCwd: "/repo/app",
      childModel: "openai/gpt-5.4:high",
    });
    const bg = vi.fn((_token: string, text: string) => text);
    const component = renderer({ data: receipt }, { expanded: false }, { ...theme, bg });

    expect(component.render(100).join("\n")).toContain("resume command · copied to clipboard");
    expect(bg).toHaveBeenCalledWith("toolSuccessBg", expect.any(String));
    expect(bg).toHaveBeenCalledWith("customMessageBg", expect.any(String));
  });

  it("renders transient clipboard outcomes without storing them in the receipt", () => {
    const receipt = buildLaunchReceipt({
      sessionId: "child-1",
      title: "Index fix",
      launch: "deferred",
      resumeCommand: "pi --session-id 'child-1'",
      targetCwd: "/repo/app",
      parentCwd: "/repo/app",
      childModel: "openai/gpt-5.4:high",
    });

    expect(renderReceipt(receipt, false, "copied")).toContain(
      "resume command · copied to clipboard",
    );
    expect(renderReceipt(receipt, false, "failed")).toContain(
      "resume command · clipboard copy failed",
    );
    expect(renderReceipt(receipt, false)).toContain("resume command\n");
    expect(receipt).not.toHaveProperty("clipboardStatus");
  });
});
