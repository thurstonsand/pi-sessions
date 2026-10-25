import { configDefaults, defineConfig } from "vitest/config";

const windows = process.platform === "win32";

// Not yet ported to Windows: these assert POSIX path shapes, or rebuild an index too slowly and then
// fail to delete files SQLite still holds open.
const UNPORTED_ON_WINDOWS = [
  "test/session-handoff.extract.test.ts",
  "test/session-index.recovery.test.ts",
  "test/session-search.db.test.ts",
  "test/session-search.extract.test.ts",
  "test/session-search.hooks.test.ts",
  "test/session-search.normalize.test.ts",
  "test/session-search.reindex.test.ts",
  "test/session-search.settings.test.ts",
];

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: windows ? [...configDefaults.exclude, ...UNPORTED_ON_WINDOWS] : configDefaults.exclude,
    // The picker tests take up to 15s each on GitHub's Windows runners.
    ...(windows ? { testTimeout: 60_000 } : {}),
  },
});
