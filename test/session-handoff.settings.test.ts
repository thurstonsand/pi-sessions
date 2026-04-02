import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../extensions/shared/settings.js";
import { createTestFilesystem } from "./test-helpers.js";

const testFs = createTestFilesystem("pi-sessions-handoff-settings-");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  testFs.cleanup();
});

describe("pi-sessions handoff settings", () => {
  it("defaults to standalone editor mode", () => {
    const agentDir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    expect(loadSettings().handoff.editorMode).toBe("standalone");
  });

  it("reads explicit powerline editor mode from global settings", () => {
    const agentDir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify(
        {
          sessions: { handoff: { editor: "powerline" } },
        },
        null,
        2,
      )}\n`,
    );

    expect(loadSettings().handoff.editorMode).toBe("powerline");
  });

  it("ignores project settings and only reads global editor mode", () => {
    const agentDir = testFs.createTempDir();
    const cwd = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });

    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify(
        {
          sessions: { handoff: { editor: "powerline" } },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      `${JSON.stringify(
        {
          sessions: { handoff: { editor: "standalone" } },
        },
        null,
        2,
      )}\n`,
    );

    expect(loadSettings().handoff.editorMode).toBe("powerline");
  });
});
