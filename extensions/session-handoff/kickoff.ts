import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { RenderTheme } from "../shared/rendering/theme.ts";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";

export const HANDOFF_KICKOFF_CUSTOM_TYPE = "pi-sessions.handoff-kickoff";

export const HANDOFF_KICKOFF_SOURCE_SCHEMA = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.Optional(Type.String()),
});

export const HANDOFF_KICKOFF_DETAILS_SCHEMA = Type.Object({
  source: HANDOFF_KICKOFF_SOURCE_SCHEMA,
  title: Type.String(),
  bootstrapEntryId: Type.Optional(Type.String()),
});

export type HandoffKickoffSource = Static<typeof HANDOFF_KICKOFF_SOURCE_SCHEMA>;
export type HandoffKickoffDetails = Static<typeof HANDOFF_KICKOFF_DETAILS_SCHEMA>;

export interface HandoffKickoffMessage {
  customType: typeof HANDOFF_KICKOFF_CUSTOM_TYPE;
  content: string;
  display: true;
  details: HandoffKickoffDetails;
}

// The kickoff is the model-visible delivery of the approved handoff prompt:
// content is exactly the prompt (provider context unchanged), details carry
// renderer metadata only.
export function buildHandoffKickoffMessage(options: {
  prompt: string;
  title: string;
  source: HandoffKickoffSource;
  bootstrapEntryId?: string | undefined;
}): HandoffKickoffMessage {
  return {
    customType: HANDOFF_KICKOFF_CUSTOM_TYPE,
    content: options.prompt,
    display: true,
    details: {
      source: buildHandoffKickoffSource(options.source),
      title: options.title,
      ...(options.bootstrapEntryId ? { bootstrapEntryId: options.bootstrapEntryId } : {}),
    },
  };
}

export function buildHandoffKickoffSource(source: HandoffKickoffSource): HandoffKickoffSource {
  return {
    sessionId: source.sessionId,
    ...(source.sessionName?.trim() ? { sessionName: source.sessionName.trim() } : {}),
  };
}

export function registerHandoffKickoffRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(HANDOFF_KICKOFF_CUSTOM_TYPE, (message, _options, theme) => {
    const details = safeParseTypeBoxValue(HANDOFF_KICKOFF_DETAILS_SCHEMA, message.details);
    if (!details) {
      return undefined;
    }

    const prompt = typeof message.content === "string" ? message.content : "";
    return createHandoffKickoffComponent(details, prompt, theme);
  });
}

export function createHandoffKickoffComponent(
  details: HandoffKickoffDetails,
  prompt: string,
  theme: RenderTheme,
): Component {
  const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
  box.addChild(new Text(renderHandoffKickoffView(details, prompt, theme), 0, 0));
  return box;
}

export function renderHandoffKickoffView(
  details: HandoffKickoffDetails,
  prompt: string,
  theme: RenderTheme,
): string {
  const label = theme.fg("toolTitle", theme.bold("handoff"));
  const header = `${label} ${theme.bold(details.title)}`;
  const from = theme.fg("muted", `from ${formatKickoffSource(details.source)}`);
  return [`${header} ${from}`, "", theme.fg("toolOutput", prompt)].join("\n");
}

function formatKickoffSource(source: HandoffKickoffDetails["source"]): string {
  const title = source.sessionName?.trim();
  return title ? `${title} (${source.sessionId})` : source.sessionId;
}
