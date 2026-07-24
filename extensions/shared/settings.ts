import os from "node:os";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { isThinkingLevel } from "./thinking-levels.ts";
import { parseTypeBoxValue } from "./typebox.ts";

export const DEFAULT_AUTO_TITLE_REFRESH_TURNS = 4;
export const DEFAULT_AUTO_TITLE_TIMEOUT_SECONDS = 15;
export const DEFAULT_AUTO_TITLE_PROMPT = `Name this coding session (under 80 chars). Be specific to what is being discussed. Your exact output will be displayed to the user, so make sure that it contains ONLY the title itself and nothing else.`;
const SESSION_FILE_SETTINGS_SCHEMA = Type.Object({
  messaging: Type.Optional(
    Type.Object({
      enable: Type.Optional(Type.Boolean()),
    }),
  ),
  subagents: Type.Optional(
    Type.Object({
      enable: Type.Optional(Type.Boolean()),
      maxDepth: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
  ),
  handoff: Type.Optional(
    Type.Object({
      enable: Type.Optional(Type.Boolean()),
      pickerShortcut: Type.Optional(Type.String()),
      persistRuns: Type.Optional(Type.Boolean()),
      model: Type.Optional(Type.String()),
      thinkingLevel: Type.Optional(Type.String()),
      deferred: Type.Optional(
        Type.Object({
          copyToClipboard: Type.Optional(Type.Boolean()),
        }),
      ),
    }),
  ),
  search: Type.Optional(
    Type.Object({
      enable: Type.Optional(Type.Boolean()),
    }),
  ),
  index: Type.Optional(
    Type.Object({
      dir: Type.Optional(Type.String()),
    }),
  ),
  autoTitle: Type.Optional(
    Type.Object({
      enable: Type.Optional(Type.Boolean()),
      refreshTurns: Type.Optional(Type.Integer({ minimum: 1 })),
      timeoutSecs: Type.Optional(Type.Integer({ minimum: 1 })),
      model: Type.Optional(Type.String()),
      thinkingLevel: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
    }),
  ),
  ask: Type.Optional(
    Type.Object({
      enable: Type.Optional(Type.Boolean()),
      model: Type.Optional(Type.String()),
      thinkingLevel: Type.Optional(Type.String()),
      persistRuns: Type.Optional(Type.Boolean()),
    }),
  ),
  hooks: Type.Optional(
    Type.Object({
      enable: Type.Optional(Type.Boolean()),
    }),
  ),
});
const ROOT_SETTINGS_SCHEMA = Type.Object({
  sessions: Type.Optional(SESSION_FILE_SETTINGS_SCHEMA),
});

export interface AgentModelSettings {
  model?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
}

export interface AutoTitleSettings extends AgentModelSettings {
  refreshTurns: number;
  timeoutMs: number;
  prompt: string;
}

export interface AskSettings extends AgentModelSettings {
  persistRuns: boolean;
}

export interface HandoffSettings extends AgentModelSettings {
  pickerShortcut: KeyId;
  persistRuns: boolean;
  deferred: {
    copyToClipboard: boolean;
  };
}

export interface FeatureToggles {
  messaging: boolean;
  subagents: boolean;
  handoff: boolean;
  search: boolean;
  ask: boolean;
  autoTitle: boolean;
  hooks: boolean;
}

export interface SessionSettings {
  features: FeatureToggles;
  subagents: {
    maxDepth: number;
  };
  handoff: HandoffSettings;
  index: {
    path: string;
  };
  autoTitle: AutoTitleSettings;
  ask: AskSettings;
}

type SessionFileSettings = Static<typeof SESSION_FILE_SETTINGS_SCHEMA>;

export function getDefaultIndexDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "pi-sessions");
}

export function getDefaultIndexPath(): string {
  return path.join(getDefaultIndexDir(), "index.sqlite");
}

export function getDefaultSessionAskRunsDir(): string {
  return path.join(getDefaultIndexDir(), "session-ask");
}

export function getDefaultHandoffRunsDir(): string {
  return path.join(getDefaultIndexDir(), "session-handoff");
}

function expandHome(rawPath: string): string {
  if (rawPath === "~") {
    return os.homedir();
  }

  if (rawPath.startsWith(`~${path.sep}`) || rawPath.startsWith("~/")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }

  return rawPath;
}

function normalizeIndexDir(value: string | undefined): string {
  if (value === undefined) {
    return getDefaultIndexDir();
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return getDefaultIndexDir();
  }

  const expanded = expandHome(trimmed);
  if (!path.isAbsolute(expanded)) {
    throw new Error('sessions.index.dir must be an absolute path or start with "~/".');
  }

  return path.normalize(expanded);
}

function normalizePickerShortcut(value: string | undefined): KeyId {
  const trimmed = value?.trim();
  return (trimmed ? trimmed : "alt+o") as KeyId;
}

function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  const trimmed = value?.trim();
  return isThinkingLevel(trimmed) ? trimmed : undefined;
}

function resolveAgentModelSettings(
  value:
    | {
        model?: string | undefined;
        thinkingLevel?: string | undefined;
      }
    | undefined,
): AgentModelSettings {
  const model = value?.model?.trim() || undefined;
  const thinkingLevel = parseThinkingLevel(value?.thinkingLevel);
  return {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

function normalizeAutoTitlePrompt(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : DEFAULT_AUTO_TITLE_PROMPT;
}

function loadSessionFileSettings(): SessionFileSettings {
  const globalSettings = SettingsManager.create(process.cwd()).getGlobalSettings();
  const parsed = parseTypeBoxValue(ROOT_SETTINGS_SCHEMA, globalSettings, "Invalid settings");
  return parsed.sessions ?? {};
}

function resolveFeatureToggles(value: SessionFileSettings): FeatureToggles {
  return {
    messaging: value.messaging?.enable ?? true,
    subagents: value.subagents?.enable ?? true,
    handoff: value.handoff?.enable ?? true,
    search: value.search?.enable ?? true,
    ask: value.ask?.enable ?? true,
    autoTitle: value.autoTitle?.enable ?? true,
    hooks: value.hooks?.enable ?? true,
  };
}

function resolveSessionSettings(fileSettings: SessionFileSettings): SessionSettings {
  const indexDir = normalizeIndexDir(fileSettings.index?.dir);

  return {
    features: resolveFeatureToggles(fileSettings),
    subagents: {
      maxDepth: fileSettings.subagents?.maxDepth ?? 2,
    },
    handoff: {
      ...resolveAgentModelSettings(fileSettings.handoff),
      pickerShortcut: normalizePickerShortcut(fileSettings.handoff?.pickerShortcut),
      persistRuns: fileSettings.handoff?.persistRuns ?? false,
      deferred: {
        copyToClipboard: fileSettings.handoff?.deferred?.copyToClipboard ?? true,
      },
    },
    index: {
      path: path.join(indexDir, "index.sqlite"),
    },
    autoTitle: {
      ...resolveAgentModelSettings(fileSettings.autoTitle),
      refreshTurns: fileSettings.autoTitle?.refreshTurns ?? DEFAULT_AUTO_TITLE_REFRESH_TURNS,
      timeoutMs: (fileSettings.autoTitle?.timeoutSecs ?? DEFAULT_AUTO_TITLE_TIMEOUT_SECONDS) * 1000,
      prompt: normalizeAutoTitlePrompt(fileSettings.autoTitle?.prompt),
    },
    ask: {
      ...resolveAgentModelSettings(fileSettings.ask),
      persistRuns: fileSettings.ask?.persistRuns ?? false,
    },
  };
}

export function loadSettings(): SessionSettings {
  return resolveSessionSettings(loadSessionFileSettings());
}
