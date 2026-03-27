import path from "node:path";
import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";
import type { AutocompleteProvider, EditorTheme, TUI } from "@mariozechner/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectHandoffPrefix,
  HandoffAutocompleteEditor,
  HandoffAutocompleteProvider,
} from "../extensions/session-handoff/autocomplete.js";
import { listHandoffAutocompleteCandidates } from "../extensions/session-handoff/query.js";
import {
  initializeSchema,
  insertSession,
  openIndexDatabase,
  rebuildSessionLineageRelations,
} from "../extensions/session-search/db.js";
import { createTestFilesystem } from "./test-helpers.js";

const testFs = createTestFilesystem("pi-sessions-handoff-autocomplete-");

const EDITOR_THEME: EditorTheme = {
  borderColor(text: string): string {
    return text;
  },
  selectList: {
    selectedPrefix(text: string): string {
      return text;
    },
    selectedText(text: string): string {
      return text;
    },
    description(text: string): string {
      return text;
    },
    scrollInfo(text: string): string {
      return text;
    },
    noMatch(text: string): string {
      return text;
    },
  },
};

afterEach(() => {
  testFs.cleanup();
});

describe("session handoff autocomplete", () => {
  it("detects a session prefix at the cursor", () => {
    expect(detectHandoffPrefix("Ask about @session", 18)).toEqual({
      raw: "@session",
      start: 10,
      end: 18,
      sessionIdPrefix: "",
    });
    expect(detectHandoffPrefix("Ask about @session:2dc89501", 27)).toEqual({
      raw: "@session:2dc89501",
      start: 10,
      end: 27,
      sessionIdPrefix: "2dc89501",
    });
    expect(detectHandoffPrefix("Ask about @session:2dc89501 more")).toBeUndefined();
  });

  it("returns handoff suggestions and applies canonical completion", () => {
    const listCandidates = vi.fn().mockReturnValue({
      mode: "lineage",
      candidates: [
        {
          value: "@session:2dc89501-5e75-4c75-bc71-15c499d850b2",
          label: "parent - Stage 3 session - 2dc89501",
          description: "Implement autocomplete",
          sessionId: "2dc89501-5e75-4c75-bc71-15c499d850b2",
        },
      ],
    });
    const baseProvider = createBaseProvider();
    const provider = new HandoffAutocompleteProvider(
      {
        baseProvider,
        getCurrentSessionPath: () => "/tmp/current.jsonl",
        getCurrentCwd: () => "/repo/app",
      },
      { listCandidates },
    );

    const suggestions = provider.getSuggestions(["Use @session:2dc8"], 0, 17);

    expect(listCandidates).toHaveBeenCalledWith({
      currentSessionPath: "/tmp/current.jsonl",
      currentCwd: "/repo/app",
      prefix: "2dc8",
      includeAll: false,
      limit: 8,
    });
    expect(suggestions?.prefix).toBe("@session:2dc8");
    expect(suggestions?.items).toHaveLength(1);
    expect(baseProvider.getSuggestions).not.toHaveBeenCalled();

    const completion = provider.applyCompletion(
      ["Use @session:2dc8"],
      0,
      17,
      suggestions?.items[0] ?? fail("missing autocomplete item"),
      suggestions?.prefix ?? fail("missing autocomplete prefix"),
    );

    expect(completion.lines).toEqual(["Use @session:2dc89501-5e75-4c75-bc71-15c499d850b2"]);
    expect(completion.cursorCol).toBe(49);
  });

  it("toggles all-session mode with alt+a while handoff autocomplete is open", () => {
    const listCandidates = vi.fn().mockImplementation((options: { includeAll: boolean }) => {
      return options.includeAll
        ? {
            mode: "all",
            defaultScopeLabel: "current repo",
            candidates: [
              {
                value: "@session:all-session",
                label: "All session - all-sess",
                description: "Other task",
                sessionId: "all-session",
              },
            ],
          }
        : {
            mode: "default",
            defaultScopeLabel: "current repo",
            candidates: [
              {
                value: "@session:lineage-session",
                label: "parent - Lineage session - lineage-",
                description: "Continue current work",
                sessionId: "lineage-session",
              },
            ],
          };
    });

    const setAutocompleteStatus = vi.fn();
    const editor = new TestHandoffAutocompleteEditor(
      createFakeTui(),
      EDITOR_THEME,
      createFakeKeybindings(),
      {
        getCurrentSessionPath: () => "/tmp/current.jsonl",
        getCurrentCwd: () => "/repo/app",
        setAutocompleteStatus,
      },
      { listCandidates },
    );
    editor.setAutocompleteProvider(createBaseProvider());
    editor.setText("Use @session:");
    editor.setAutocompleteVisible(true);

    const provider = editor.getProvider();
    expect(provider).toBeDefined();

    const beforeToggle = provider?.getSuggestions(editor.getLines(), 0, editor.getCursor().col);
    expect(beforeToggle?.items[0]?.value).toBe("@session:lineage-session");

    editor.handleInput("\x1ba");

    const afterToggle = provider?.getSuggestions(editor.getLines(), 0, editor.getCursor().col);
    expect(afterToggle?.items[0]?.value).toBe("@session:all-session");
    expect(listCandidates).toHaveBeenLastCalledWith({
      currentSessionPath: "/tmp/current.jsonl",
      currentCwd: "/repo/app",
      prefix: "",
      includeAll: true,
      limit: 8,
    });

    editor.handleInput("\x1ba");
  });

  it("uses the current scope label when toggling back from all sessions", () => {
    const listCandidates = vi.fn().mockReturnValue({
      mode: "default",
      defaultScopeLabel: "current repo",
      candidates: [
        {
          value: "@session:fallback-session",
          label: "project - fallback-session",
          description: "Fallback task",
          sessionId: "fallback-session",
        },
      ],
    });
    const setAutocompleteStatus = vi.fn();
    const editor = new TestHandoffAutocompleteEditor(
      createFakeTui(),
      EDITOR_THEME,
      createFakeKeybindings(),
      {
        getCurrentSessionPath: () => "/tmp/current.jsonl",
        getCurrentCwd: () => "/repo/app",
        setAutocompleteStatus,
      },
      { listCandidates },
    );
    editor.setAutocompleteProvider(createBaseProvider());
    editor.setText("Use @session");
    editor.setAutocompleteVisible(true);

    const provider = editor.getProvider();
    const suggestions = provider?.getSuggestions(editor.getLines(), 0, editor.getCursor().col);

    expect(suggestions?.items[0]?.value).toBe("@session:fallback-session");
    editor.handleInput("\x1ba");
    expect(setAutocompleteStatus).toHaveBeenLastCalledWith("Alt+A: show all sessions");
    expect(listCandidates).toHaveBeenCalledTimes(1);
  });

  it("surfaces provider-owned hint text and powerline actions", () => {
    const listCandidates = vi.fn().mockImplementation((options: { includeAll: boolean }) => {
      return options.includeAll
        ? {
            mode: "all",
            defaultScopeLabel: "current repo",
            candidates: [
              {
                value: "@session:all-session",
                label: "All session - all-sess",
                description: "Other task",
                sessionId: "all-session",
              },
            ],
          }
        : {
            mode: "default",
            defaultScopeLabel: "current repo",
            candidates: [
              {
                value: "@session:lineage-session",
                label: "parent - Lineage session - lineage-",
                description: "Continue current work",
                sessionId: "lineage-session",
              },
            ],
          };
    });

    const provider = new HandoffAutocompleteProvider(
      {
        baseProvider: createBaseProvider(),
        getCurrentSessionPath: () => "/tmp/current.jsonl",
        getCurrentCwd: () => "/repo/app",
      },
      { listCandidates },
    );

    const suggestions = provider.getSuggestions(["Use @session:"], 0, 13);
    expect(suggestions?.items[0]?.value).toBe("@session:lineage-session");
    expect(provider.getPowerlineAutocompleteHint()).toBe("Alt+A: show all sessions");
    provider.toggleIncludeAllSessions();

    const toggledSuggestions = provider.getSuggestions(["Use @session:"], 0, 13);
    expect(toggledSuggestions?.items[0]?.value).toBe("@session:all-session");
    expect(provider.getPowerlineAutocompleteHint()).toBe("Alt+A: show current repo sessions");
  });

  it("lists lineage candidates with durable goal and next-task labels", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");
    const currentSessionPath = "/tmp/current.jsonl";
    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);

    insertSession(
      db,
      {
        sessionId: "11111111-1111-4111-8111-111111111111",
        sessionPath: "/tmp/parent.jsonl",
        sessionName: "Parent session",
        firstUserPrompt: "Resume the parent work",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-23T00:00:00.000Z",
        modifiedAt: "2026-03-23T00:10:00.000Z",
        messageCount: 3,
        entryCount: 4,
        handoffGoal: "Parent goal",
        handoffNextTask: "Implement autocomplete",
      },
      "full_reindex",
    );
    insertSession(
      db,
      {
        sessionId: "22222222-2222-4222-8222-222222222222",
        sessionPath: currentSessionPath,
        sessionName: "Current session",
        firstUserPrompt: "Continue current session",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-23T00:20:00.000Z",
        modifiedAt: "2026-03-23T00:30:00.000Z",
        messageCount: 3,
        entryCount: 4,
        parentSessionPath: "/tmp/parent.jsonl",
        parentSessionId: "11111111-1111-4111-8111-111111111111",
        sessionOrigin: "handoff",
      },
      "full_reindex",
    );
    insertSession(
      db,
      {
        sessionId: "33333333-3333-4333-8333-333333333333",
        sessionPath: "/tmp/sibling.jsonl",
        sessionName: "Sibling session",
        firstUserPrompt: "Check the sibling edge cases",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-23T00:40:00.000Z",
        modifiedAt: "2026-03-23T00:50:00.000Z",
        messageCount: 3,
        entryCount: 4,
        parentSessionPath: "/tmp/parent.jsonl",
        parentSessionId: "11111111-1111-4111-8111-111111111111",
        sessionOrigin: "handoff",
        handoffNextTask: "Triage edge cases",
      },
      "full_reindex",
    );
    insertSession(
      db,
      {
        sessionId: "44444444-4444-4444-8444-444444444444",
        sessionPath: "/tmp/unrelated.jsonl",
        sessionName: "",
        firstUserPrompt: "Investigate unrelated issue",
        cwd: "/repo/other",
        repoRoots: ["/repo"],
        startedAt: "2026-03-23T01:00:00.000Z",
        modifiedAt: "2026-03-23T01:10:00.000Z",
        messageCount: 3,
        entryCount: 4,
        handoffGoal: "Unrelated goal",
      },
      "full_reindex",
    );
    rebuildSessionLineageRelations(db);
    db.close();

    const lineageCandidates = listHandoffAutocompleteCandidates({
      currentSessionPath,
      prefix: "",
      includeAll: false,
      indexPath: dbPath,
    });
    const allCandidates = listHandoffAutocompleteCandidates({
      currentSessionPath,
      prefix: "",
      includeAll: true,
      indexPath: dbPath,
    });

    expect(lineageCandidates.mode).toBe("default");
    expect(lineageCandidates.defaultScopeLabel).toBe("current repo");
    expect(lineageCandidates.candidates.map((candidate) => candidate.value)).toEqual([
      "@session:11111111-1111-4111-8111-111111111111",
      "@session:33333333-3333-4333-8333-333333333333",
      "@session:44444444-4444-4444-8444-444444444444",
    ]);
    expect(lineageCandidates.candidates[0]).toMatchObject({
      label: "parent - Parent session - 11111111",
      description: "Implement autocomplete",
    });
    expect(lineageCandidates.candidates[1]).toMatchObject({
      label: "sibling - Sibling session - 33333333",
      description: "Triage edge cases",
    });
    expect(lineageCandidates.candidates[2]).toMatchObject({
      label: "other - 44444444",
      description: "Unrelated goal",
    });

    expect(allCandidates.mode).toBe("all");
    expect(allCandidates.candidates.map((candidate) => candidate.value)).toEqual([
      "@session:11111111-1111-4111-8111-111111111111",
      "@session:33333333-3333-4333-8333-333333333333",
      "@session:44444444-4444-4444-8444-444444444444",
    ]);
    expect(allCandidates.candidates[0]).toMatchObject({
      label: "parent (app) - Parent session - 11111111",
      description: "Implement autocomplete",
    });
    expect(allCandidates.candidates[1]).toMatchObject({
      label: "sibling (app) - Sibling session - 33333333",
      description: "Triage edge cases",
    });
    expect(allCandidates.candidates[2]).toMatchObject({
      label: "other - 44444444",
      description: "Unrelated goal",
    });
  });
});

class TestHandoffAutocompleteEditor extends HandoffAutocompleteEditor {
  private autocompleteVisible = false;

  setAutocompleteVisible(visible: boolean): void {
    this.autocompleteVisible = visible;
  }

  override isShowingAutocomplete(): boolean {
    return this.autocompleteVisible;
  }

  getProvider(): HandoffAutocompleteProvider | undefined {
    return this.getHandoffProvider();
  }
}

function createBaseProvider(): AutocompleteProvider {
  return {
    getSuggestions: vi.fn().mockReturnValue(null),
    applyCompletion: vi.fn(),
  };
}

function createFakeTui(): TUI {
  return {
    terminal: { rows: 24, cols: 120 },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function createFakeKeybindings(): KeybindingsManager {
  return {
    matches: vi.fn().mockReturnValue(false),
  } as unknown as KeybindingsManager;
}

function fail(message: string): never {
  throw new Error(message);
}
