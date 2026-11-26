import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installIndex } from "../extensions/session-index/install.ts";
import type { SessionSettings } from "../extensions/shared/settings.ts";
import { createFakeExtensionApi, createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-index-command-");

afterEach(() => {
  vi.unstubAllEnvs();
  testFs.cleanup();
});

describe("/session-index over RPC", () => {
  it("offers the rebuild through host dialogs and reports the rebuilt index", async () => {
    const root = testFs.createTempDir();
    testFs.writeJsonlFile(path.join(root, "sessions", "project"), "a.jsonl", [
      {
        type: "session",
        version: 3,
        id: "session-a",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd: root,
      },
    ]);
    vi.stubEnv("PI_CODING_AGENT_DIR", root);
    const pi = createFakeExtensionApi();
    installIndex(pi, {
      settings: { index: { path: path.join(root, "index.sqlite") } } as SessionSettings,
    });
    const handler = vi.mocked(pi.registerCommand).mock.calls[0]?.[1].handler;
    const ui = {
      notify: vi.fn(),
      custom: vi.fn(async () => undefined),
      select: vi.fn(async () => "Rebuild from disk"),
      confirm: vi.fn(async () => true),
    };

    await handler?.("", { hasUI: true, mode: "rpc", ui } as never);

    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.select).toHaveBeenCalledWith(expect.stringContaining("<no index found>"), [
      "Rebuild from disk",
      "Close",
    ]);
    expect(ui.notify).toHaveBeenLastCalledWith("Indexed 1 sessions and 0 text chunks.", "info");
  });
});
