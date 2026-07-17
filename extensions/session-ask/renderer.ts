import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { ExpandableContentLayout } from "../shared/rendering/expandable-content-layout.ts";
import { formatSessionTitleOrShortId } from "../shared/session-ui.ts";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";
import { buildSessionAskPresentation } from "./presenter.ts";
import {
  SESSION_ASK_PROGRESS_DETAILS_SCHEMA,
  SESSION_ASK_RESULT_DETAILS_SCHEMA,
} from "./tool-contract.ts";
import { buildSessionAskView } from "./view-model.ts";

interface SessionAskToolRendererState {
  layout?: ExpandableContentLayout | undefined;
}

interface SessionAskToolRenderContext {
  state: SessionAskToolRendererState;
  isError: boolean;
}

export function renderSessionAskResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: SessionAskToolRenderContext,
): Component {
  const content = result.content[0];
  if (content?.type !== "text") {
    return new Text(theme.fg("error", "No session output"), 0, 0);
  }

  if (context.isError) {
    return new Text(theme.fg("error", content.text), 0, 0);
  }

  if (options.isPartial) {
    const details = safeParseTypeBoxValue(SESSION_ASK_PROGRESS_DETAILS_SCHEMA, result.details);
    const lines = [theme.bold(theme.fg("warning", "Reading session..."))];
    if (details) {
      const identity = formatSessionTitleOrShortId(details.sessionName, details.sessionId);
      lines.push(`title: ${theme.fg("accent", identity)}`);
    }
    if (details?.question) {
      lines.push(theme.fg("muted", `prompt: ${details.question}`));
    }
    return new Text(lines.join("\n"), 0, 0);
  }

  const details = safeParseTypeBoxValue(SESSION_ASK_RESULT_DETAILS_SCHEMA, result.details);
  if (!details) {
    return new Text(content.text, 0, 0);
  }

  const layout = context.state.layout ?? new ExpandableContentLayout(theme);
  context.state.layout = layout;
  layout.update(buildSessionAskPresentation(buildSessionAskView(details), theme), options.expanded);
  return layout;
}
