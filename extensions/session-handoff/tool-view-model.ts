import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { normalizeOptionalText } from "../shared/text.ts";
import { isThinkingLevel } from "../shared/thinking-levels.ts";
import { parseModelArgument } from "./model.ts";
import type { HandoffToolDetails } from "./tool-contract.ts";

export interface HandoffToolViewModel {
  launch?: string | undefined;
  title?: string | undefined;
  goal?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  result?: HandoffToolDetails | undefined;
}

export function buildHandoffToolView(
  args: unknown,
  result?: HandoffToolDetails | undefined,
): HandoffToolViewModel {
  const record = isRecord(args) ? args : {};
  const argumentModel = readString(record.model);
  const parsedArgumentModel = argumentModel ? parseModelArgument(argumentModel) : undefined;
  const parsedResultModel = result ? parseModelArgument(result.model) : undefined;
  const model =
    normalizeOptionalText(result?.modelName) ??
    parsedResultModel?.model ??
    parsedArgumentModel?.model;
  const thinkingLevel =
    result?.thinkingLevel ??
    readThinkingLevel(record.thinkingLevel) ??
    parsedResultModel?.thinkingLevel ??
    parsedArgumentModel?.thinkingLevel;
  return {
    launch: readString(record.launch) ?? result?.launch,
    title: readString(record.title) ?? result?.title,
    goal: readString(record.goal),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(result ? { result } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readThinkingLevel(value: unknown): ThinkingLevel | undefined {
  const level = readString(value);
  return isThinkingLevel(level) ? level : undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return normalizeOptionalText(value);
}
