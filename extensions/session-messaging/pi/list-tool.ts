import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ExpandableContentLayout } from "../../shared/rendering/expandable-content-layout.ts";
import { renderToolNameCall } from "../../shared/rendering/tool-name-call.ts";
import { safeParseTypeBoxValue } from "../../shared/typebox.ts";
import type { SessionDirectory } from "../directory.ts";
import {
  type SESSION_LIST_PARAMS,
  SESSION_LIST_TOOL_DETAILS_SCHEMA,
  type SESSION_LIST_USER_PARAMS,
  type SessionListParams,
  type SessionListScope,
  type SessionListToolDetails,
} from "./list-contract.ts";
import { buildSessionListPresentation } from "./list-presenter.ts";
import { buildSessionListView } from "./list-view-model.ts";

interface SessionListRendererState {
  layout?: ExpandableContentLayout | undefined;
}

export interface ListToolOptions {
  name: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: typeof SESSION_LIST_PARAMS | typeof SESSION_LIST_USER_PARAMS;
  defaultScope: SessionListScope;
}

export function createSessionListTool(
  directory: SessionDirectory,
  options: ListToolOptions,
): ToolDefinition {
  return defineTool({
    name: options.name,
    label: "Sessions",
    description: options.description,
    promptSnippet: options.promptSnippet,
    promptGuidelines: options.promptGuidelines,
    annotations: { readOnlyHint: true, openWorldHint: false },
    parameters: options.parameters,
    outputSchema: SESSION_LIST_TOOL_DETAILS_SCHEMA,
    renderCall: renderToolNameCall(options.name),
    renderResult(result, options, theme, context) {
      const output = result.content.find((item) => item.type === "text")?.text ?? "";
      if (context.isError) return new Text(output ? theme.fg("error", output) : "", 0, 0);
      const details = safeParseTypeBoxValue(SESSION_LIST_TOOL_DETAILS_SCHEMA, result.details);
      if (!details) return new Text(output, 0, 0);
      const state = context.state as SessionListRendererState;
      const layout = state.layout ?? new ExpandableContentLayout(theme);
      state.layout = layout;
      layout.update(
        buildSessionListPresentation(buildSessionListView(details), theme),
        options.expanded,
      );
      return layout;
    },
    async execute(_toolCallId, params: SessionListParams, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? options.defaultScope;
      const sessions = await directory.list(scope, ctx);
      const details: SessionListToolDetails = { scope, sessions };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
        details,
        structuredContent: details,
      };
    },
  });
}
