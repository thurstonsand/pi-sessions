import os from "node:os";
import path from "node:path";
import { getAgentDir, SettingsManager } from "@mariozechner/pi-coding-agent";

const DEFAULT_HANDOFF_EDITOR_MODE = "standalone" as const;

export type SessionHandoffEditorMode = "standalone" | "powerline";

export interface PiSessionsSettings {
  handoff: {
    editorMode: SessionHandoffEditorMode;
  };
  index: {
    dir: string;
    path: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function normalizeIndexDir(value: unknown): string {
  if (typeof value !== "string") {
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

function drillRecord(root: unknown, ...keys: string[]): unknown {
  let current = root;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function readConfiguredHandoffEditorMode(settings: unknown): SessionHandoffEditorMode | undefined {
  const editor = drillRecord(settings, "sessions", "handoff", "editor");
  if (editor === undefined) {
    return undefined;
  }

  return editor === "powerline" || editor === "standalone" ? editor : DEFAULT_HANDOFF_EDITOR_MODE;
}

function readConfiguredIndexDir(settings: unknown): string {
  const dir = drillRecord(settings, "sessions", "index", "dir");
  if (dir === undefined) {
    return getDefaultIndexDir();
  }

  return normalizeIndexDir(dir);
}

export function loadSettings(): PiSessionsSettings {
  const globalSettings = SettingsManager.create(undefined, getAgentDir()).getGlobalSettings();
  const indexDir = readConfiguredIndexDir(globalSettings);

  return {
    handoff: {
      editorMode: readConfiguredHandoffEditorMode(globalSettings) ?? DEFAULT_HANDOFF_EDITOR_MODE,
    },
    index: {
      dir: indexDir,
      path: path.join(indexDir, "index.sqlite"),
    },
  };
}
