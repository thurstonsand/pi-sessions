import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { safeParseTypeBoxValue } from "../shared/typebox.js";

export const AUTO_TITLE_STATE_CUSTOM_TYPE = "pi-sessions.auto-title";
export const AUTO_TITLE_STATE_VERSION = 1;

export const AUTO_TITLE_MODE_SCHEMA = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused_manual"),
]);
export const AUTO_TITLE_TRIGGER_SCHEMA = Type.Union([
  Type.Literal("initial"),
  Type.Literal("periodic"),
  Type.Literal("manual"),
]);
export const AUTO_TITLE_STATE_SCHEMA = Type.Object({
  version: Type.Literal(AUTO_TITLE_STATE_VERSION),
  mode: AUTO_TITLE_MODE_SCHEMA,
  lastAutoTitle: Type.Optional(Type.String()),
  lastAppliedUserTurnCount: Type.Optional(Type.Integer({ minimum: 1 })),
  lastTrigger: Type.Optional(AUTO_TITLE_TRIGGER_SCHEMA),
  updatedAt: Type.String(),
});

export type AutoTitleMode = Static<typeof AUTO_TITLE_MODE_SCHEMA>;
export type AutoTitleTrigger = Static<typeof AUTO_TITLE_TRIGGER_SCHEMA>;
export type AutoTitlePersistedState = Static<typeof AUTO_TITLE_STATE_SCHEMA>;

export function createAutoTitleState(options?: {
  mode?: AutoTitleMode;
  lastAutoTitle?: string;
  lastAppliedUserTurnCount?: number;
  lastTrigger?: AutoTitleTrigger;
  updatedAt?: string;
}): AutoTitlePersistedState {
  return {
    version: AUTO_TITLE_STATE_VERSION,
    mode: options?.mode ?? "active",
    ...(options?.lastAutoTitle ? { lastAutoTitle: options.lastAutoTitle } : {}),
    ...(options?.lastAppliedUserTurnCount
      ? { lastAppliedUserTurnCount: options.lastAppliedUserTurnCount }
      : {}),
    ...(options?.lastTrigger ? { lastTrigger: options.lastTrigger } : {}),
    updatedAt: options?.updatedAt ?? new Date().toISOString(),
  };
}

export function parseAutoTitleState(value: unknown): AutoTitlePersistedState | undefined {
  return safeParseTypeBoxValue(AUTO_TITLE_STATE_SCHEMA, value);
}

export function getLatestAutoTitleState(
  entries: SessionEntry[],
): AutoTitlePersistedState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== AUTO_TITLE_STATE_CUSTOM_TYPE) {
      continue;
    }

    const parsed = parseAutoTitleState(entry.data);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}
