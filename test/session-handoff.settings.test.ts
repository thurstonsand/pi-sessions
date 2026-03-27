import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionHandoffSettings } from "../extensions/session-handoff/settings.js";
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

describe("session handoff settings", () => {
  it("reads nested host config and detects powerline from packages", () => {
    const agentDir = testFs.createTempDir();
    const cwd = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify(
        {
          packages: ["npm:pi-powerline-footer"],
          sessions: { handoff: { editor: { host: "powerline" } } },
        },
        null,
        2,
      )}\n`,
    );

    expect(readSessionHandoffSettings(cwd)).toMatchObject({
      editorHost: "powerline",
      powerlineConfigured: true,
    });
  });

  it("lets project settings override host config and detect explicit extension paths", () => {
    const agentDir = testFs.createTempDir();
    const cwd = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });

    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify(
        {
          sessions: { handoff: { editor: { host: "powerline" } } },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      `${JSON.stringify(
        {
          extensions: ["./extensions/pi-powerline-footer/index.ts"],
          sessions: { handoff: { editor: { host: "standalone" } } },
        },
        null,
        2,
      )}\n`,
    );

    expect(readSessionHandoffSettings(cwd)).toMatchObject({
      editorHost: "standalone",
      powerlineConfigured: true,
    });
  });
});
