import type { HandoffSplitDirection } from "./launch/backend.ts";
import { DEFERRED_LAUNCH } from "./launch-target.ts";

export const HANDOFF_USAGE =
  "Usage: /handoff [--left|--right|--up|--down|--deferred] <goal for new thread>";

export type HandoffCommand =
  | { kind: "identify" }
  | {
      kind: "ok";
      goal: string;
      launch?: HandoffSplitDirection | typeof DEFERRED_LAUNCH | undefined;
      model?: string | undefined;
    }
  | { kind: "error"; message: string };

export function parseHandoffCommandArgs(args: string): HandoffCommand {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  if (tokens.includes("--identify")) {
    return { kind: "identify" };
  }
  if (tokens.length === 0) {
    return { kind: "error", message: HANDOFF_USAGE };
  }

  const launchFlags = new Map<string, HandoffSplitDirection | typeof DEFERRED_LAUNCH>([
    ["--left", "left"],
    ["--right", "right"],
    ["--up", "up"],
    ["--down", "down"],
    ["--deferred", DEFERRED_LAUNCH],
  ]);
  let launch: HandoffSplitDirection | typeof DEFERRED_LAUNCH | undefined;
  let model: string | undefined;
  const goalTokens: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === "--model") {
      const value = tokens[index + 1];
      if (!value) {
        return { kind: "error", message: HANDOFF_USAGE };
      }
      model = value;
      index += 1;
      continue;
    }

    const target = launchFlags.get(token);
    if (!target) {
      goalTokens.push(token);
      continue;
    }
    if (launch) {
      return {
        kind: "error",
        message: "Use only one launch target: --left, --right, --up, --down, or --deferred.",
      };
    }
    launch = target;
  }

  const goal = goalTokens.join(" ").trim();
  return goal ? { kind: "ok", goal, launch, model } : { kind: "error", message: HANDOFF_USAGE };
}
