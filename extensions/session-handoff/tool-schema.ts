import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  DEFERRED_LAUNCH,
  type HandoffLaunchTarget,
  LAUNCH_DIRECTIONS,
  SUBAGENT_LAUNCH,
} from "./launch-target.ts";
import { formatRosterEntry, type HandoffRoster } from "./roster.ts";

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

const MODEL_INHERITANCE_GUIDELINES = [
  "Leave provider and model unset to run the handoff on this session's current model.",
  "To run the handoff on a different model, set both provider and model together (both are required).",
];

const RESTRICTED_THINKING_GUIDELINE =
  'A ":level" suffix on a listed model limits it to those thinking levels; set thinkingLevel to one of them, or leave it unset when only one is listed.';

const SUBAGENT_MODEL_OVERRIDE_GUIDELINE =
  "For subagents, choose the model that best fits the delegated task; for other launches, only override the model when the task clearly warrants it. When unsure, ask the user for their preference.";

const DEFAULT_MODEL_OVERRIDE_GUIDELINE =
  "Only override the model when the task clearly warrants it.";

export function buildHandoffPromptGuidelines(
  targets: readonly HandoffLaunchTarget[],
  models: readonly Model<Api>[],
  roster: HandoffRoster | undefined,
): string[] {
  const hasSubagent = offersSubagentLaunch(targets);
  const userFacingKinds = describeUserFacingLaunchKinds(targets);
  const selectable =
    roster?.map(formatRosterEntry) ?? models.map((model) => `${model.provider}/${model.id}`);
  return [
    ...(hasSubagent ? SUBAGENT_GUIDELINES : []),
    ...(userFacingKinds
      ? [`Use session_handoff ${userFacingKinds} launches only when the user requests one.`]
      : []),
    ...MODEL_INHERITANCE_GUIDELINES,
    hasSubagent ? SUBAGENT_MODEL_OVERRIDE_GUIDELINE : DEFAULT_MODEL_OVERRIDE_GUIDELINE,
    ...(selectable.length > 0
      ? [`Available models, given as provider/model-id: ${selectable.join(", ")}.`]
      : []),
    ...(roster?.some((entry) => entry.thinkingLevels) ? [RESTRICTED_THINKING_GUIDELINE] : []),
  ];
}

export function offersSubagentLaunch(targets: readonly HandoffLaunchTarget[]): boolean {
  return targets.some((target) => target.value === SUBAGENT_LAUNCH);
}

function describeUserFacingLaunchKinds(targets: readonly HandoffLaunchTarget[]): string {
  const isDirection = (value: string) => LAUNCH_DIRECTIONS.some((direction) => direction === value);
  const kinds = [
    targets.some((target) => isDirection(target.value)) ? "directional" : undefined,
    targets.some(
      (target) =>
        target.value !== SUBAGENT_LAUNCH &&
        target.value !== DEFERRED_LAUNCH &&
        !isDirection(target.value),
    )
      ? "host"
      : undefined,
    targets.some((target) => target.value === DEFERRED_LAUNCH) ? "deferred" : undefined,
  ];
  return kinds.filter((kind) => kind !== undefined).join(" or ");
}
