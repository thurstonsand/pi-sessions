import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_TITLE_PROMPT,
  DEFAULT_AUTO_TITLE_REFRESH_TURNS,
  DEFAULT_AUTO_TITLE_TOKEN_BUDGET,
  loadSettings,
} from "../extensions/shared/settings.ts";
import { createTestFilesystem } from "./test-helpers.ts";

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
    expect(settings.autoTitle.tokenBudget).toBe(DEFAULT_AUTO_TITLE_TOKEN_BUDGET);
    expect(settings.autoTitle.model).toBeUndefined();
    expect(settings.autoTitle.prompt).toBe(DEFAULT_AUTO_TITLE_PROMPT);
    expect(settings.autoTitle.persistRuns).toBe(false);
    expect(settings.ask.persistRuns).toBe(false);
    expect(settings.handoff.persistRuns).toBe(false);
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
              tokenBudget: 512,
              model: " openai/gpt-5.4-mini ",
              prompt: " Use terse subsystem titles. ",
              persistRuns: true,
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
    expect(settings.autoTitle.tokenBudget).toBe(512);
    expect(settings.autoTitle.model).toBe("openai/gpt-5.4-mini");
    expect(settings.autoTitle.prompt).toBe("Use terse subsystem titles.");
    expect(settings.autoTitle.persistRuns).toBe(true);
  });

  it("reads explicit handoff settings from global settings", () => {
    const agentDir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify(
        {
          sessions: {
            handoff: {
              model: " openai-codex/gpt-5.6-terra ",
              thinkingLevel: "low",
              persistRuns: true,
            },
          },
        },
        null,
        2,
      )}
`,
    );

    const settings = loadSettings();
    expect(settings.handoff.model).toBe("openai-codex/gpt-5.6-terra");
    expect(settings.handoff.thinkingLevel).toBe("low");
    expect(settings.handoff.persistRuns).toBe(true);
  });

  it("reads explicit ask settings from global settings", () => {
    const agentDir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify(
        {
          sessions: {
            ask: {
              model: "anthropic/claude-sonnet-4-5",
              thinkingLevel: "xhigh",
              persistRuns: true,
            },
          },
        },
        null,
        2,
      )}
`,
    );

    const settings = loadSettings();
    expect(settings.ask.model).toBe("anthropic/claude-sonnet-4-5");
    expect(settings.ask.thinkingLevel).toBe("xhigh");
    expect(settings.ask.persistRuns).toBe(true);
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
    expect(settings.autoTitle.model).toBe("google/gemini-flash-lite-latest");
  });

  it("uses the default auto-title prompt for blank prompt settings", () => {
    const agentDir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify(
        {
          sessions: {
            autoTitle: { prompt: "   " },
          },
        },
        null,
        2,
      )}
`,
    );

    expect(loadSettings().autoTitle.prompt).toBe(DEFAULT_AUTO_TITLE_PROMPT);
  });

  it("keeps bare model patterns for CLI-style resolution", () => {
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

    expect(loadSettings().autoTitle.model).toBe("gpt-5.4-mini");
  });
});
