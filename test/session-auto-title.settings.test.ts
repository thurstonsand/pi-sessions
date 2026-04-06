import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_TITLE_REFRESH_TURNS,
  loadSettings,
  ModelReference,
} from "../extensions/shared/settings.js";
import { createTestFilesystem } from "./test-helpers.js";

const testFs = createTestFilesystem("pi-sessions-auto-title-settings-");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  testFs.cleanup();
});

describe("pi-sessions auto-title settings", () => {
  it("uses the built-in defaults", () => {
    const agentDir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const settings = loadSettings();
    expect(settings.autoTitle.refreshTurns).toBe(DEFAULT_AUTO_TITLE_REFRESH_TURNS);
    expect(settings.autoTitle.model).toBeUndefined();
  });

  it("reads explicit auto-title settings from global settings", () => {
    const agentDir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify(
        {
          sessions: {
            autoTitle: {
              refreshTurns: 6,
              model: " openai/gpt-5.4-mini ",
            },
          },
        },
        null,
        2,
      )}
`,
    );

    const settings = loadSettings();
    expect(settings.autoTitle.refreshTurns).toBe(6);
    expect(settings.autoTitle.model).toBeInstanceOf(ModelReference);
    expect(settings.autoTitle.model).toMatchObject({
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });
    expect(settings.autoTitle.model?.toString()).toBe("openai/gpt-5.4-mini");
  });

  it("ignores project settings and only reads global auto-title settings", () => {
    const agentDir = testFs.createTempDir();
    const cwd = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });

    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify(
        {
          sessions: {
            autoTitle: { refreshTurns: 5, model: "google/gemini-flash-lite-latest" },
          },
        },
        null,
        2,
      )}
`,
    );
    writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      `${JSON.stringify(
        {
          sessions: { autoTitle: { refreshTurns: 9, model: "openai/gpt-5.4-mini" } },
        },
        null,
        2,
      )}
`,
    );

    const settings = loadSettings();
    expect(settings.autoTitle.refreshTurns).toBe(5);
    expect(settings.autoTitle.model).toBeInstanceOf(ModelReference);
    expect(settings.autoTitle.model).toMatchObject({
      provider: "google",
      modelId: "gemini-flash-lite-latest",
    });
    expect(settings.autoTitle.model?.toString()).toBe("google/gemini-flash-lite-latest");
  });

  it("drops invalid auto-title model references", () => {
    const agentDir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify(
        {
          sessions: {
            autoTitle: { model: "gpt-5.4-mini" },
          },
        },
        null,
        2,
      )}
`,
    );

    expect(loadSettings().autoTitle.model).toBeUndefined();
  });
});
