import os from "node:os";
import path from "node:path";
import { getAgentDir, SettingsManager } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { parseTypeBoxValue } from "./typebox.js";

const DEFAULT_HANDOFF_EDITOR_MODE = "standalone" as const;
const SESSION_HANDOFF_EDITOR_MODE_SCHEMA = Type.Union([
  Type.Literal("standalone"),
  Type.Literal("powerline"),
]);
const SESSION_FILE_SETTINGS_SCHEMA = Type.Object({
  handoff: Type.Optional(
    Type.Object({
      editor: Type.Optional(SESSION_HANDOFF_EDITOR_MODE_SCHEMA),
    }),
  ),
  index: Type.Optional(
    Type.Object({
      dir: Type.Optional(Type.String()),
    }),
  ),
});
const ROOT_SETTINGS_SCHEMA = Type.Object({
  sessions: Type.Optional(SESSION_FILE_SETTINGS_SCHEMA),
});

export type SessionHandoffEditorMode = Static<typeof SESSION_HANDOFF_EDITOR_MODE_SCHEMA>;

export interface SessionSettings {
  handoff: {
    editorMode: SessionHandoffEditorMode;
  };
  index: {
    path: string;
  };
}

type SessionFileSettings = Static<typeof SESSION_FILE_SETTINGS_SCHEMA>;

export function getDefaultIndexDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "pi-sessions");
}

export function getDefaultIndexPath(): string {
  return path.join(getDefaultIndexDir(), "index.sqlite");
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

function loadSessionFileSettings(): SessionFileSettings {
  const globalSettings = SettingsManager.create(undefined, getAgentDir()).getGlobalSettings();
  const parsed = parseTypeBoxValue(ROOT_SETTINGS_SCHEMA, globalSettings, "Invalid settings");
  return parsed.sessions ?? {};
}

function resolveSessionSettings(fileSettings: SessionFileSettings): SessionSettings {
  const indexDir = normalizeIndexDir(fileSettings.index?.dir);

  return {
    handoff: {
      editorMode: fileSettings.handoff?.editor ?? DEFAULT_HANDOFF_EDITOR_MODE,
    },
    index: {
      path: path.join(indexDir, "index.sqlite"),
    },
  };
}

export function loadSettings(): SessionSettings {
  return resolveSessionSettings(loadSessionFileSettings());
}
