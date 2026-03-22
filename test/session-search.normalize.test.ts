import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveSessionRepoRoots,
  matchesRepoRoot,
  normalizePathRecord,
} from "../extensions/session-search/normalize.js";
import { createTestFilesystem } from "./test-helpers.js";

const testFs = createTestFilesystem("pi-sessions-normalize-");

afterEach(() => {
  testFs.cleanup();
});

describe("session-search normalize", () => {
  it("normalizes relative paths and derives repo metadata", () => {
    const root = testFs.createTempDir();
    const repoRoot = testFs.ensureDir(path.join(root, "repo"));
    testFs.ensureDir(path.join(repoRoot, ".git"));
    const cwd = testFs.ensureDir(path.join(repoRoot, "src"));

    const normalized = normalizePathRecord("lib/index.ts", cwd);

    expect(normalized.absPath).toBe(`${repoRoot}/src/lib/index.ts`);
    expect(normalized.cwdRelPath).toBe("lib/index.ts");
    expect(normalized.repoRoot).toBe(repoRoot);
    expect(normalized.repoRelPath).toBe("src/lib/index.ts");
    expect(normalized.basename).toBe("index.ts");
    expect(normalized.pathScope).toBe("relative");
  });

  it("aggregates repo roots from cwd and touched files", () => {
    const root = testFs.createTempDir();
    const firstRepo = testFs.ensureDir(path.join(root, "repo-one"));
    const secondRepo = testFs.ensureDir(path.join(root, "repo-two"));
    testFs.ensureDir(path.join(firstRepo, ".git"));
    testFs.ensureDir(path.join(secondRepo, ".git"));

    const repoRoots = deriveSessionRepoRoots(firstRepo, [
      normalizePathRecord(`${secondRepo}/docs/readme.md`, firstRepo),
    ]);

    expect(repoRoots).toEqual([firstRepo, secondRepo]);
    expect(matchesRepoRoot(firstRepo, firstRepo)).toBe(true);
    expect(matchesRepoRoot(secondRepo, "repo-two")).toBe(true);
  });
});
