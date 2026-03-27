import { getAgentDir, SettingsManager } from "@mariozechner/pi-coding-agent";
import { isPowerlineConfiguredInSettings } from "pi-powerline-footer";

const DEFAULT_EDITOR_HOST = "auto" as const;

export type SessionHandoffEditorHost = "auto" | "standalone" | "powerline";

export interface SessionHandoffSettings {
  editorHost: SessionHandoffEditorHost;
  powerlineConfigured: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEditorHost(value: unknown): SessionHandoffEditorHost {
  return value === "standalone" || value === "powerline" || value === "auto"
    ? value
    : DEFAULT_EDITOR_HOST;
}

function readConfiguredEditorHost(settings: unknown): SessionHandoffEditorHost | undefined {
  if (!isRecord(settings)) {
    return undefined;
  }

  const sessions = settings.sessions;
  if (!isRecord(sessions)) {
    return undefined;
  }

  const handoff = sessions.handoff;
  if (!isRecord(handoff)) {
    return undefined;
  }

  const editor = handoff.editor;
  if (!isRecord(editor) || editor.host === undefined) {
    return undefined;
  }

  return normalizeEditorHost(editor.host);
}

export function readSessionHandoffSettings(cwd: string): SessionHandoffSettings {
  const settingsManager = SettingsManager.create(cwd, getAgentDir());
  const projectEditorHost = readConfiguredEditorHost(settingsManager.getProjectSettings());

  return {
    editorHost:
      projectEditorHost ??
      readConfiguredEditorHost(settingsManager.getGlobalSettings()) ??
      DEFAULT_EDITOR_HOST,
    powerlineConfigured: isPowerlineConfiguredInSettings(
      settingsManager.getPackages(),
      settingsManager.getExtensionPaths(),
    ),
  };
}
