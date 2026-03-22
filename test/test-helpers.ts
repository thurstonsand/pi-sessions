import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TestFilesystem {
  createTempDir(): string;
  cleanup(): void;
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
    writeJsonlFile(dir, name, lines) {
      mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, name);
      writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      return filePath;
    },
  };
}
