import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { RenderTheme } from "../shared/rendering/theme.ts";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";
import type { ClipboardStatus } from "./launch/backend.ts";

export const HANDOFF_LAUNCH_RECEIPT_CUSTOM_TYPE = "pi-sessions.handoff-launch-receipt";

export const HANDOFF_LAUNCH_RECEIPT_SCHEMA = Type.Object({
  sessionId: Type.String(),
  title: Type.String(),
  launch: Type.Union([
    Type.Literal("deferred"),
    Type.Literal("left"),
    Type.Literal("right"),
    Type.Literal("up"),
    Type.Literal("down"),
    Type.Literal("subagent"),
  ]),
  resumeCommand: Type.String(),
  backend: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  model: Type.String(),
});

export type HandoffLaunchReceipt = Static<typeof HANDOFF_LAUNCH_RECEIPT_SCHEMA>;

export function buildLaunchReceipt(options: {
  sessionId: string;
  title: string;
  launch: HandoffLaunchReceipt["launch"];
  resumeCommand: string;
  backend?: string | undefined;
  targetCwd: string;
  parentCwd: string;
  childModel: string;
}): HandoffLaunchReceipt {
  return {
    sessionId: options.sessionId,
    title: options.title,
    launch: options.launch,
    resumeCommand: options.resumeCommand,
    ...(options.backend ? { backend: options.backend } : {}),
    ...(options.targetCwd !== options.parentCwd ? { cwd: options.targetCwd } : {}),
    model: options.childModel,
  };
}

interface LaunchReceiptView {
  summary: string;
  command?: string | undefined;
  commandLabel?: string | undefined;
}

export function createLaunchReceiptComponent(
  receipt: HandoffLaunchReceipt,
  expanded: boolean,
  theme: RenderTheme,
  clipboardStatus?: ClipboardStatus | undefined,
): Component {
  const view = buildLaunchReceiptView(receipt, expanded, theme, clipboardStatus);
  const container = new Container();
  container.addChild(new Text(view.summary, 0, 0));
  if (view.command) {
    container.addChild(new Spacer(1));
    container.addChild(
      createLaunchCommandComponent(view.command, view.commandLabel ?? "resume command", theme),
    );
  }
  return container;
}

export function createLaunchCommandComponent(
  command: string,
  label: string,
  theme: RenderTheme,
): Component {
  const container = new Container();
  container.addChild(new Text(theme.fg("muted", label), 0, 0));
  const commandBox = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
  commandBox.addChild(new Text(theme.fg("toolOutput", command), 0, 0));
  container.addChild(commandBox);
  return container;
}

function buildLaunchReceiptView(
  receipt: HandoffLaunchReceipt,
  expanded: boolean,
  theme: RenderTheme,
  clipboardStatus?: ClipboardStatus | undefined,
): LaunchReceiptView {
  const label = theme.fg("toolTitle", theme.bold("handoff"));
  if (receipt.launch === "deferred") {
    const lines = [`${label} ${theme.fg("muted", "ready")} ${theme.bold(receipt.title)}`];
    if (expanded) {
      lines.push(`${theme.fg("muted", "id")} ${receipt.sessionId}`);
      if (receipt.cwd) {
        lines.push(`${theme.fg("muted", "cwd")} ${receipt.cwd}`);
      }
    }
    lines.push(`${theme.fg("muted", "model")} ${receipt.model}`);
    return {
      summary: lines.join("\n"),
      command: receipt.resumeCommand,
      commandLabel: formatDeferredCommandLabel(clipboardStatus),
    };
  }

  const lines = [
    `${label} ${theme.fg("muted", "launched")} ${theme.bold(receipt.title)}`,
    theme.fg("dim", `${receipt.launch} · ${receipt.sessionId}`),
    `${theme.fg("muted", "model")} ${receipt.model}`,
  ];
  if (expanded) {
    lines.push(`${theme.fg("muted", "id")} ${receipt.sessionId}`);
    const backend = receipt.backend ? `${receipt.backend} ` : "";
    lines.push(`${theme.fg("muted", "launched")} ${backend}${receipt.launch}`);
    if (receipt.cwd) {
      lines.push(`${theme.fg("muted", "cwd")} ${receipt.cwd}`);
    }
  }
  return {
    summary: lines.join("\n"),
    ...(expanded ? { command: receipt.resumeCommand, commandLabel: "recovery command" } : {}),
  };
}

export function formatDeferredCommandLabel(clipboardStatus?: ClipboardStatus | undefined): string {
  switch (clipboardStatus) {
    case "copied":
      return "resume command · copied to clipboard";
    case "failed":
      return "resume command · clipboard copy failed";
    default:
      return "resume command";
  }
}

export function createHandoffLaunchReceiptRenderer(
  getClipboardStatus: (sessionId: string) => ClipboardStatus | undefined = () => undefined,
): EntryRenderer {
  return (entry, options, theme) => {
    const receipt = safeParseTypeBoxValue(HANDOFF_LAUNCH_RECEIPT_SCHEMA, entry.data);
    if (!receipt) {
      return undefined;
    }

    const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
    box.addChild(
      createLaunchReceiptComponent(
        receipt,
        options.expanded,
        theme,
        getClipboardStatus(receipt.sessionId),
      ),
    );
    return box;
  };
}
