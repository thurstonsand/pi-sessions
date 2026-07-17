import { normalizeOptionalText } from "../shared/text.ts";
import type { HandoffToolDetails } from "./tool-contract.ts";

export interface HandoffToolViewModel {
  launch?: string | undefined;
  title?: string | undefined;
  goal?: string | undefined;
  result?: HandoffToolDetails | undefined;
}

export function buildHandoffToolView(
  args: unknown,
  result?: HandoffToolDetails | undefined,
): HandoffToolViewModel {
  const record = isRecord(args) ? args : {};
  return {
    launch: readString(record.launch) ?? result?.launch,
    title: readString(record.title) ?? result?.title,
    goal: readString(record.goal),
    ...(result ? { result } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return normalizeOptionalText(value);
}
