import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { normalizeOptionalText } from "../shared/text.ts";
import { isThinkingLevel } from "../shared/thinking-levels.ts";
import type { HandoffToolDetails } from "./tool-contract.ts";

export interface HandoffToolViewModel {
  launch?: string | undefined;
  title?: string | undefined;
  goal?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  result?: HandoffToolDetails | undefined;
}

export function buildHandoffToolView(
  args: unknown,
  result?: HandoffToolDetails | undefined,
): HandoffToolViewModel {
  const record = isRecord(args) ? args : {};
  const provider = normalizeOptionalText(result?.provider) ?? readString(record.provider);
  const model = normalizeOptionalText(result?.modelName) ?? readString(record.model);
  const thinkingLevel = result?.thinkingLevel ?? readThinkingLevel(record.thinkingLevel);
  return {
    launch: readString(record.launch) ?? result?.launch,
    title: readString(record.title) ?? result?.title,
    goal: readString(record.goal),
    ...(provider ? { provider } : {}),
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
