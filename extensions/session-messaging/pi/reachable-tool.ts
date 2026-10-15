import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ExpandableContentLayout } from "../../shared/rendering/expandable-content-layout.ts";
import { safeParseTypeBoxValue } from "../../shared/typebox.ts";
import type { SessionDirectory } from "../directory.ts";
import {
  type SESSION_REACHABLE_PARAMS,
  SESSION_REACHABLE_TOOL_DETAILS_SCHEMA,
  type SESSION_REACHABLE_USER_PARAMS,
  type SessionReachableParams,
  type SessionReachableScope,
  type SessionReachableToolDetails,
} from "./reachable-contract.ts";
import { buildSessionReachablePresentation } from "./reachable-presenter.ts";
import { buildSessionReachableView } from "./reachable-view-model.ts";

interface SessionReachableRendererState {
  layout?: ExpandableContentLayout | undefined;
}

export interface ReachableToolOptions {
  name: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: typeof SESSION_REACHABLE_PARAMS | typeof SESSION_REACHABLE_USER_PARAMS;
  defaultScope: SessionReachableScope;
}

export function createSessionReachableTool(
  directory: SessionDirectory,
  options: ReachableToolOptions,
): ToolDefinition {
  return defineTool({
    name: options.name,
    label: "Reachable Sessions",
    description: options.description,
    promptSnippet: options.promptSnippet,
    promptGuidelines: options.promptGuidelines,
    annotations: { readOnlyHint: true, openWorldHint: false },
    parameters: options.parameters,
    outputSchema: SESSION_REACHABLE_TOOL_DETAILS_SCHEMA,
    renderResult(result, options, theme, context) {
      const output = result.content.find((item) => item.type === "text")?.text ?? "";
      if (context.isError) return new Text(output ? theme.fg("error", output) : "", 0, 0);
      const details = safeParseTypeBoxValue(SESSION_REACHABLE_TOOL_DETAILS_SCHEMA, result.details);
      if (!details) return new Text(output, 0, 0);
      const state = context.state as SessionReachableRendererState;
      const layout = state.layout ?? new ExpandableContentLayout(theme);
      state.layout = layout;
      layout.update(
        buildSessionReachablePresentation(buildSessionReachableView(details), theme),
        options.expanded,
      );
      return layout;
    },
    async execute(_toolCallId, params: SessionReachableParams, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? options.defaultScope;
      const sessions = await directory.list(scope, ctx);
      const details: SessionReachableToolDetails = { scope, sessions };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
        details,
        structuredContent: details,
      };
    },
  });
}
