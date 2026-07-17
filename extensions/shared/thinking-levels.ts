import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

// Pi exports the ThinkingLevel type but no runtime list of its members
// (getSupportedThinkingLevels requires a concrete model). This object is the
// one local runtime definition; Record makes upstream additions a type error.
const THINKING_LEVELS_BY_NAME = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
} satisfies Record<ThinkingLevel, true>;

export const THINKING_LEVELS = Object.freeze(
  Object.keys(THINKING_LEVELS_BY_NAME) as ThinkingLevel[],
);

export function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
  return value !== undefined && Object.hasOwn(THINKING_LEVELS_BY_NAME, value);
}
