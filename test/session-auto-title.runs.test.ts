import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateAutoTitle } from "../extensions/session-auto-title/generate.ts";
import {
  AUTO_TITLE_RUN_FAILURE_CUSTOM_TYPE,
  AUTO_TITLE_RUN_REQUEST_CUSTOM_TYPE,
} from "../extensions/session-auto-title/runs.ts";
import { getDefaultAutoTitleRunsDir } from "../extensions/shared/settings.ts";
import { createFakeModelRuntime, createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-auto-title-runs-");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  testFs.cleanup();
});

const titleContext = {
  cwd: "/repo/app",
  currentTitle: undefined,
  conversationText: "user: rename the widget factory",
  userTurnCount: 1,
  assistantTurnCount: 1,
};

const model = { provider: "openai", id: "gpt-5.4-mini" } as never;

function runEntries(): Array<Record<string, unknown>> {
  const runsDir = getDefaultAutoTitleRunsDir();
  const runFiles = readdirSync(runsDir);
  expect(runFiles).toHaveLength(1);

  return readFileSync(path.join(runsDir, runFiles[0] as string), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createRuntime(completeSimple: (...args: unknown[]) => Promise<unknown>) {
  return createFakeModelRuntime({ all: [], available: [], completeSimple }) as never;
}

describe("auto-title run persistence", () => {
  it("does not write a run when persistRuns is off", async () => {
    process.env.PI_CODING_AGENT_DIR = testFs.createTempDir();
    const completeSimple = vi.fn().mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "Widget Factory Rename" }],
    });

    await generateAutoTitle(createRuntime(completeSimple), model, titleContext, "manual", {
      systemPrompt: "Name this coding session.",
      timeoutMs: 15_000,
      tokenBudget: 64,
      thinkingLevel: undefined,
      persistRuns: false,
    });

    expect(readdirSync(process.env.PI_CODING_AGENT_DIR)).toEqual([]);
  });

  it("records the full prompt and response as a replayable session", async () => {
    process.env.PI_CODING_AGENT_DIR = testFs.createTempDir();
    const completeSimple = vi.fn().mockResolvedValue({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Widget Factory Rename" }],
    });

    await generateAutoTitle(createRuntime(completeSimple), model, titleContext, "manual", {
      systemPrompt: "Name this coding session.",
      timeoutMs: 15_000,
      tokenBudget: 64,
      thinkingLevel: "low",
      persistRuns: true,
    });

    const entries = runEntries();
    const request = entries.find(
      (entry) => entry.customType === AUTO_TITLE_RUN_REQUEST_CUSTOM_TYPE,
    );
    expect(request?.data).toEqual({
      trigger: "manual",
      systemPrompt: "Name this coding session.",
      tokenBudget: 64,
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        type: "model_change",
        provider: "openai",
        modelId: "gpt-5.4-mini",
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ type: "thinking_level_change", thinkingLevel: "low" }),
    );

    const messageTexts = entries
      .filter((entry) => entry.type === "message")
      .map((entry) => (entry.message as { content: [{ text: string }] }).content[0].text);
    expect(messageTexts[0]).toContain(
      "<conversation>\nuser: rename the widget factory\n</conversation>",
    );
    expect(messageTexts[0]).toContain(
      "<title_instructions>\nName this coding session.\n</title_instructions>",
    );
    expect(messageTexts[1]).toBe("Widget Factory Rename");
  });

  it("records why a run failed", async () => {
    process.env.PI_CODING_AGENT_DIR = testFs.createTempDir();
    const completeSimple = vi.fn().mockResolvedValue({
      role: "assistant",
      stopReason: "length",
      content: [{ type: "thinking", thinking: "Okay, the user wants a short title" }],
    });

    await generateAutoTitle(createRuntime(completeSimple), model, titleContext, "periodic", {
      systemPrompt: "Name this coding session.",
      timeoutMs: 15_000,
      tokenBudget: 64,
      thinkingLevel: undefined,
      persistRuns: true,
    });

    const failure = runEntries().find(
      (entry) => entry.customType === AUTO_TITLE_RUN_FAILURE_CUSTOM_TYPE,
    );
    expect(failure?.data).toEqual({
      message:
        "Model spent its 64-token budget without producing a title. Raise sessions.autoTitle.tokenBudget if the model reasons before answering.",
    });
  });
});
