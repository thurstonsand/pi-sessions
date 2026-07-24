import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Text } from "@earendil-works/pi-tui";
import { type Static, type TLiteral, Type } from "typebox";
import type { RenderTheme } from "../shared/rendering/theme.ts";
import { THINKING_LEVELS } from "../shared/thinking-levels.ts";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";
import type { ClipboardStatus } from "./launch/backend.ts";
import { HANDOFF_LAUNCH_VALUE_SCHEMA, type HandoffLaunchValue } from "./launch-target.ts";

const THINKING_LEVEL_SCHEMAS = THINKING_LEVELS.map((level) => Type.Literal(level)) as [
  TLiteral<ThinkingLevel>,
  ...TLiteral<ThinkingLevel>[],
];

export const HANDOFF_LAUNCH_RECEIPT_SCHEMA = Type.Object({
  sessionId: Type.String(),
  childSessionFile: Type.String(),
  title: Type.String(),
  launch: HANDOFF_LAUNCH_VALUE_SCHEMA,
  resumeCommand: Type.String(),
  backend: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  model: Type.String(),
  provider: Type.Optional(Type.String()),
  modelName: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(Type.Union(THINKING_LEVEL_SCHEMAS)),
});

export type HandoffLaunchReceipt = Static<typeof HANDOFF_LAUNCH_RECEIPT_SCHEMA>;

export function parseHandoffLaunchReceiptEntry(
  entry: SessionEntry,
): HandoffLaunchReceipt | undefined {
  if (
    entry.type === "message" &&
    entry.message.role === "toolResult" &&
    entry.message.toolName === "session_handoff"
  ) {
    return safeParseTypeBoxValue(HANDOFF_LAUNCH_RECEIPT_SCHEMA, entry.message.details);
  }
  return undefined;
}

export function buildLaunchReceipt(options: {
  sessionId: string;
  childSessionFile: string;
  title: string;
  launch: HandoffLaunchValue;
  resumeCommand: string;
  backend?: string | undefined;
  targetCwd: string;
  parentCwd: string;
  childModel: string;
  childProvider: string;
  childModelName: string;
  thinkingLevel?: ThinkingLevel | undefined;
}): HandoffLaunchReceipt {
  return {
    sessionId: options.sessionId,
    childSessionFile: options.childSessionFile,
    title: options.title,
    launch: options.launch,
    resumeCommand: options.resumeCommand,
    ...(options.backend ? { backend: options.backend } : {}),
    ...(options.targetCwd !== options.parentCwd ? { cwd: options.targetCwd } : {}),
    model: options.childModel,
    provider: options.childProvider,
    modelName: options.childModelName,
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
  };
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
