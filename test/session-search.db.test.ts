import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getIndexStatus,
  INDEX_SCHEMA_VERSION,
  initializeSchema,
  openIndexDatabase,
  setMetadata,
} from "../extensions/session-search/db.js";
import { createTestFilesystem } from "./test-helpers.js";

const testFs = createTestFilesystem("pi-sessions-db-");

afterEach(() => {
  testFs.cleanup();
});

describe("session-search db", () => {
  it("creates schema and reports status", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const status = getIndexStatus(dbPath);
    expect(status.exists).toBe(true);
    expect(status.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
    expect(status.lastFullReindexAt).toBe("2026-03-22T00:00:00.000Z");
    expect(status.sessionCount).toBe(0);
  });
});
