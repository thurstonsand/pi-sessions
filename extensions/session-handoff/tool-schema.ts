import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { formatAvailableModelList } from "../shared/model-resolution.ts";
import { type HandoffLaunchTarget, SUBAGENT_LAUNCH } from "./launch-target.ts";

export function buildHandoffLaunchSchema(targets: readonly HandoffLaunchTarget[]) {
  const descriptions = targets.flatMap((target) =>
    target.description ? [target.description] : [],
  );
  return Type.Union(
    targets.map((target) => Type.Literal(target.value)),
    {
      description: ["Where to launch the child session.", ...descriptions].join(" "),
    },
  );
}

export function buildHandoffPromptGuidelines(targets: readonly HandoffLaunchTarget[]): string[] {
  const subagentGuidelines = targets.some((target) => target.value === SUBAGENT_LAUNCH)
    ? [
        'Use session_handoff with launch: "subagent" for a concrete, bounded task that can proceed independently while useful work continues in the current session.',
        "Do not launch a subagent for work that is trivial, duplicates work already underway, requires frequent coordination, or is tightly coupled to the current session's immediate next step.",
        "Tell every subagent explicitly whether it may modify files or should only investigate and report.",
        "Give concurrent subagents disjoint responsibilities and non-overlapping write scopes.",
        "After launching a subagent, do not sleep, poll, or repeatedly check its progress; continue useful work or finish the current turn and wait for its report.",
      ]
    : [];
  return [
    ...subagentGuidelines,
    "Use session_handoff directional or deferred launches only when the user requests one.",
  ];
}

export function buildHandoffModelDescription(models: readonly Model<Api>[]): string {
  const base =
    "Model for the child session as 'provider/model-id'. Defaults to the current session's model. For subagents, choose the appropriate model for the task. Otherwise only override when the task clearly warrants a different model.";
  return models.length === 0
    ? `${base} No configured models are listed; leave blank to use the current session's model.`
    : `${base} Available models: ${formatAvailableModelList(models)}.`;
}
