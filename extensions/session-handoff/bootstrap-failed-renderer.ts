import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { RenderTheme } from "../shared/rendering/theme.ts";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";
import { HANDOFF_BOOTSTRAP_FAILED_SCHEMA, type HandoffBootstrapFailed } from "./metadata.ts";

export const renderHandoffBootstrapFailedEntry: EntryRenderer = (entry, _options, theme) => {
  const failure = safeParseTypeBoxValue(HANDOFF_BOOTSTRAP_FAILED_SCHEMA, entry.data);
  if (!failure) {
    return undefined;
  }

  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(presentHandoffBootstrapFailure(failure, theme), 0, 0));
  return box;
};

export function presentHandoffBootstrapFailure(
  failure: HandoffBootstrapFailed,
  theme: RenderTheme,
): string {
  const header = `${theme.fg("error", theme.bold("handoff failed"))} ${theme.fg("muted", "draft generation did not complete")}`;
  const retry = theme.fg(
    "dim",
    "The handoff is retried every time this session starts, until a message is sent.",
  );
  return [header, "", theme.fg("toolOutput", failure.error), "", retry].join("\n");
}
