import os from "node:os";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { parseTypeBoxValue } from "./typebox.ts";

export const DEFAULT_AUTO_TITLE_REFRESH_TURNS = 4;
export const DEFAULT_AUTO_TITLE_TIMEOUT_SECONDS = 15;
export const DEFAULT_AUTO_TITLE_PROMPT = `Name this coding session (under 80 chars). Be specific to what is being discussed. Your exact output will be displayed to the user, so make sure that it contains ONLY the title itself and nothing else.`;
const SESSION_FILE_SETTINGS_SCHEMA = Type.Object({
  handoff: Type.Optional(
    Type.Object({
      pickerShortcut: Type.Optional(Type.String()),
    }),
  ),
  index: Type.Optional(
    Type.Object({
      dir: Type.Optional(Type.String()),
    }),
  ),
  autoTitle: Type.Optional(
    Type.Object({
      refreshTurns: Type.Optional(Type.Integer({ minimum: 1 })),
      timeoutSecs: Type.Optional(Type.Integer({ minimum: 1 })),
      model: Type.Optional(Type.String()),
      thinkingLevel: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
    }),
  ),
  ask: Type.Optional(
    Type.Object({
      model: Type.Optional(Type.String()),
      thinkingLevel: Type.Optional(Type.String()),
      persistRuns: Type.Optional(Type.Boolean()),
    }),
  ),
});
const ROOT_SETTINGS_SCHEMA = Type.Object({
  sessions: Type.Optional(SESSION_FILE_SETTINGS_SCHEMA),
});

export class ModelReference {
  constructor(
    readonly provider: string,
    readonly modelId: string,
  ) {}

  toString(): string {
    return `${this.provider}/${this.modelId}`;
  }
}

export interface AgentModelSettings {
  model?: ModelReference | undefined;
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

export interface SessionSettings {
  handoff: {
    pickerShortcut: KeyId;
  };
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

export function parseModelReference(value: string | undefined): ModelReference | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return undefined;
  }

  return new ModelReference(trimmed.slice(0, slashIndex), trimmed.slice(slashIndex + 1));
}

function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  const trimmed = value?.trim();
  switch (trimmed) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return trimmed;
    default:
      return undefined;
  }
}

function resolveAgentModelSettings(
  value:
    | {
        model?: string | undefined;
        thinkingLevel?: string | undefined;
      }
    | undefined,
): AgentModelSettings {
  const model = parseModelReference(value?.model);
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

function resolveSessionSettings(fileSettings: SessionFileSettings): SessionSettings {
  const indexDir = normalizeIndexDir(fileSettings.index?.dir);

  return {
    handoff: {
      pickerShortcut: normalizePickerShortcut(fileSettings.handoff?.pickerShortcut),
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
