import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultIndexPath, loadSettings } from "../extensions/shared/settings.js";
import { createTestFilesystem } from "./test-helpers.js";

const testFs = createTestFilesystem("pi-sessions-settings-");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  testFs.cleanup();
});

describe("pi-sessions index settings", () => {
  it("uses the built-in default index location", () => {
    const agentDir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const settings = loadSettings();
    expect(settings.index.path).toBe(getDefaultIndexPath());
  });

  it("reads an explicit index dir from global settings", () => {
    const agentDir = testFs.createTempDir();
    const dir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    writeFileSync(
      `${agentDir}/settings.json`,
      `${JSON.stringify({ sessions: { index: { dir } } }, null, 2)}\n`,
    );

    const settings = loadSettings();
    expect(settings.index.path).toBe(`${dir}/index.sqlite`);
  });

  it("ignores project settings and only reads the global index dir", () => {
    const agentDir = testFs.createTempDir();
    const cwd = testFs.createTempDir();
    const globalDir = testFs.createTempDir();
    const projectDir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(`${cwd}/.pi`, { recursive: true });

    writeFileSync(
      `${agentDir}/settings.json`,
      `${JSON.stringify({ sessions: { index: { dir: globalDir } } }, null, 2)}\n`,
    );
    writeFileSync(
      `${cwd}/.pi/settings.json`,
      `${JSON.stringify({ sessions: { index: { dir: projectDir } } }, null, 2)}\n`,
    );

    const settings = loadSettings();
    expect(settings.index.path).toBe(`${globalDir}/index.sqlite`);
  });

  it("rejects relative index dirs", () => {
    const agentDir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    writeFileSync(
      `${agentDir}/settings.json`,
      `${JSON.stringify({ sessions: { index: { dir: ".cache/pi-sessions" } } }, null, 2)}\n`,
    );

    expect(() => loadSettings()).toThrow(
      'sessions.index.dir must be an absolute path or start with "~/".',
    );
  });
});
