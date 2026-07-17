import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
