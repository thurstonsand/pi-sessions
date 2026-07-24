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

const SUBAGENT_GUIDELINES = [
  'Use session_handoff with launch: "subagent" for a concrete, bounded task that can proceed independently while useful work continues in the current session.',
  "Do not launch a subagent for work that is trivial, duplicates work already underway, requires frequent coordination, or is tightly coupled to the current session's immediate next step.",
  "Tell every subagent explicitly whether it may modify files or should only investigate and report.",
  "Give concurrent subagents disjoint responsibilities and non-overlapping write scopes.",
  "After launching a subagent, do not sleep, poll, or repeatedly check its progress; continue useful work or finish the current turn and wait for its report.",
];

const LAUNCH_TARGET_GUIDELINE =
  "Use session_handoff directional or deferred launches only when the user requests one.";

const MODEL_INHERITANCE_GUIDELINES = [
  "Leave provider and model unset to run the handoff on this session's current model.",
  "To run the handoff on a different model, set both provider and model together (both are required).",
];

const SUBAGENT_MODEL_OVERRIDE_GUIDELINE =
  "For subagents, choose the model that best fits the delegated task; for directional or deferred handoffs, only override the model when the task clearly warrants it. When unsure, ask the user for their preference.";

const DEFAULT_MODEL_OVERRIDE_GUIDELINE =
  "Only override the model when the task clearly warrants it.";

export function buildHandoffPromptGuidelines(
  targets: readonly HandoffLaunchTarget[],
  models: readonly Model<Api>[],
): string[] {
  const hasSubagent = targets.some((target) => target.value === SUBAGENT_LAUNCH);
  return [
    ...(hasSubagent ? SUBAGENT_GUIDELINES : []),
    LAUNCH_TARGET_GUIDELINE,
    ...MODEL_INHERITANCE_GUIDELINES,
    hasSubagent ? SUBAGENT_MODEL_OVERRIDE_GUIDELINE : DEFAULT_MODEL_OVERRIDE_GUIDELINE,
    ...(models.length > 0
      ? [`Available models, given as provider/model-id: ${formatAvailableModelList(models)}.`]
      : []),
  ];
}
