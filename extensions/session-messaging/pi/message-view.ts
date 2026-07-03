import { Box, type Component, getKeybindings, type Keybinding, Text } from "@earendil-works/pi-tui";
import type { ReceivedMessageEntry } from "./message-contracts.ts";

const COLLAPSED_MESSAGE_LINES = 10;

interface MessageViewTheme {
  bold(text: string): string;
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
}

interface MessageViewOptions {
  expanded: boolean;
  status: "sending" | "received";
  targetSessionId?: string | undefined;
  sourceSessionId?: string | undefined;
  sourceSessionName?: string | undefined;
  message: string;
  requestResponse?: boolean | undefined;
  relation?: string | undefined;
}

export function renderSessionMessageView(
  options: MessageViewOptions,
  theme: MessageViewTheme,
): string {
  const header = formatHeader(options, theme);
  const body = formatMessageBody(options.message, options.expanded, theme);
  return body ? `${header}\n\n${body}` : header;
}

export function createReceivedSessionMessageComponent(
  received: ReceivedMessageEntry,
  expanded: boolean,
  theme: MessageViewTheme,
): Component {
  const box = new Box(1, 1, (text: string) => theme.bg("toolSuccessBg", text));
  box.addChild(
    new Text(
      renderSessionMessageView(
        {
          expanded,
          status: "received",
          sourceSessionId: received.source.sessionId,
          sourceSessionName: received.source.sessionName,
          message: received.body,
          requestResponse: received.requestResponse,
          relation: received.relation,
        },
        theme,
      ),
      0,
      0,
    ),
  );
  return box;
}

export function formatSendMessageCall(
  args: { session?: string; message?: string; requestResponse?: boolean } | undefined,
  expanded: boolean,
  status: "sending",
  theme: MessageViewTheme,
  relation?: string | undefined,
): string {
  return renderSessionMessageView(
    {
      expanded,
      status,
      targetSessionId: args?.session,
      message: args?.message ?? "",
      requestResponse: args?.requestResponse,
      relation,
    },
    theme,
  );
}

function formatHeader(options: MessageViewOptions, theme: MessageViewTheme): string {
  const toolName = options.status === "received" ? "incoming_message" : "session_send_message";
  const name = theme.fg("toolTitle", theme.bold(toolName));
  const metadata = [
    options.relation,
    options.requestResponse ? "response requested" : undefined,
  ].filter((item): item is string => Boolean(item));
  const metadataHint = metadata.length > 0 ? theme.fg("muted", ` (${metadata.join(", ")})`) : "";
  switch (options.status) {
    case "received":
      return `${name} ${theme.fg("muted", `from ${formatSourceLabel(options)}`)}${metadataHint}`;
    case "sending":
      return `${name} ${theme.fg("muted", `to ${options.targetSessionId ?? "[target pending]"}`)}${metadataHint}`;
  }
}

function formatSourceLabel(options: MessageViewOptions): string {
  if (!options.sourceSessionId) {
    return "[source unknown]";
  }

  const title = options.sourceSessionName?.trim();
  return title ? `${title} (${options.sourceSessionId})` : options.sourceSessionId;
}

function formatKeyHint(
  keybinding: Keybinding,
  description: string,
  theme: MessageViewTheme,
): string {
  const keyText = getKeybindings().getKeys(keybinding).join("/");
  return `${theme.fg("dim", keyText)}${theme.fg("muted", ` ${description}`)}`;
}

function formatMessageBody(message: string, expanded: boolean, theme: MessageViewTheme): string {
  if (!message) {
    return "";
  }

  const lines = message.replaceAll("\t", "  ").split("\n");
  const maxLines = expanded ? lines.length : COLLAPSED_MESSAGE_LINES;
  const visibleLines = lines.slice(0, maxLines);
  const remaining = lines.length - visibleLines.length;
  const body = visibleLines.map((line) => theme.fg("toolOutput", line)).join("\n");
  if (remaining <= 0) {
    return body;
  }

  return `${body}${theme.fg(
    "muted",
    `\n... (${remaining} more lines, ${lines.length} total,`,
  )} ${formatKeyHint("app.tools.expand", "to expand", theme)}${theme.fg("muted", ")")}`;
}
