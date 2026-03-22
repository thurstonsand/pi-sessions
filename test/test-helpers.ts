import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
