import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

export function createFakeExtensionApi(): ExtensionAPI {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    setLabel: vi.fn(),
    exec: vi.fn(),
    getActiveTools: vi.fn(),
    getAllTools: vi.fn(),
    setActiveTools: vi.fn(),
    getCommands: vi.fn(),
    setModel: vi.fn(),
    getThinkingLevel: vi.fn(),
    setThinkingLevel: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    events: {
      emit: vi.fn(),
      on: vi.fn().mockReturnValue(() => {}),
    },
  };
}

interface FakeRegistryModel {
  provider: string;
  id: string;
}

export function createFakeModelRegistry(options: {
  available: FakeRegistryModel[];
  all?: FakeRegistryModel[];
}) {
  const all = options.all ?? options.available;
  const isAvailable = (model: FakeRegistryModel) =>
    options.available.some((m) => m.provider === model.provider && m.id === model.id);

  return {
    getAll: () => all,
    getAvailable: () => options.available,
    hasConfiguredAuth: (model: FakeRegistryModel) => isAvailable(model),
    async getApiKeyAndHeaders() {
      return { ok: true, apiKey: "test-key", headers: undefined };
    },
  };
}

export function createFakeModelRuntime(options: {
  available: FakeRegistryModel[];
  all?: FakeRegistryModel[];
  completeSimple?: (...args: unknown[]) => Promise<unknown>;
}) {
  const all = options.all ?? options.available;

  return {
    getModels: () => all,
    getAvailableSnapshot: () => options.available,
    getModel: (provider: string, modelId: string) =>
      all.find((model) => model.provider === provider && model.id === modelId),
    hasConfiguredAuth: (provider: string) =>
      options.available.some((model) => model.provider === provider),
    completeSimple: options.completeSimple,
  };
}

export interface TestFilesystem {
  createTempDir(): string;
  cleanup(): void;
  ensureDir(dir: string): string;
  writeJsonlFile(dir: string, name: string, lines: unknown[]): string;
}

export function createTestFilesystem(prefix: string): TestFilesystem {
  const tempDirs: string[] = [];

  return {
    createTempDir() {
      const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    },
    cleanup() {
      for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    ensureDir(dir) {
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    writeJsonlFile(dir, name, lines) {
      mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, name);
      writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      return filePath;
    },
  };
}
