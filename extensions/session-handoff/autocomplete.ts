import { CustomEditor, type KeybindingsManager } from "@mariozechner/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type EditorTheme,
  matchesKey,
  type TUI,
} from "@mariozechner/pi-tui";
import { type HandoffAutocompleteCandidate, listHandoffAutocompleteCandidates } from "./query.js";

type HandoffAutocompleteMode = "default" | "all";

const SESSION_PREFIX_RE = /(?:^|[\s([{"'])@session(?::([0-9a-fA-F-]*))?$/;
const SESSION_TOKEN_PREFIX = "@session:";
const DEFAULT_AUTOCOMPLETE_LIMIT = 8;

interface HandoffAutocompleteDeps {
  listCandidates: typeof listHandoffAutocompleteCandidates;
}

const defaultDeps: HandoffAutocompleteDeps = {
  listCandidates: listHandoffAutocompleteCandidates,
};

export interface HandoffPrefixMatch {
  raw: string;
  start: number;
  end: number;
  sessionIdPrefix: string;
}

interface HandoffAutocompleteProviderOptions {
  baseProvider: AutocompleteProvider;
  getCurrentSessionPath: () => string | undefined;
  getCurrentCwd: () => string | undefined;
  limit?: number | undefined;
}

interface ForceAutocompleteProvider extends AutocompleteProvider {
  getForceFileSuggestions?(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): { items: AutocompleteItem[]; prefix: string } | null;
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

export interface HandoffAutocompleteEditorOptions {
  getCurrentSessionPath: () => string | undefined;
  getCurrentCwd: () => string | undefined;
  setAutocompleteStatus: (text: string | undefined) => void;
  limit?: number | undefined;
}

export function detectHandoffPrefix(
  text: string,
  cursor: number = text.length,
): HandoffPrefixMatch | undefined {
  const head = text.slice(0, cursor);
  const match = head.match(SESSION_PREFIX_RE);
  if (!match) {
    return undefined;
  }

  const bareStart = head.lastIndexOf("@session");
  const colonStart = head.lastIndexOf(SESSION_TOKEN_PREFIX);
  const start = Math.max(bareStart, colonStart);
  if (start < 0) {
    return undefined;
  }

  return {
    raw: head.slice(start),
    start,
    end: cursor,
    sessionIdPrefix: match[1] ?? "",
  };
}

export function isCanonicalSessionToken(text: string): boolean {
  return text.startsWith(SESSION_TOKEN_PREFIX);
}

export class HandoffAutocompleteProvider implements ForceAutocompleteProvider {
  private readonly baseProvider: AutocompleteProvider;
  private readonly getCurrentSessionPath: () => string | undefined;
  private readonly getCurrentCwd: () => string | undefined;
  private readonly limit: number;
  private readonly specialItems = new WeakSet<AutocompleteItem>();
  private readonly deps: HandoffAutocompleteDeps;
  private includeAllSessions = false;
  private hasActiveHandoffSuggestions = false;
  private autocompleteMode?: HandoffAutocompleteMode | undefined;
  private defaultScopeLabel?: string | undefined;

  constructor(
    options: HandoffAutocompleteProviderOptions,
    deps: HandoffAutocompleteDeps = defaultDeps,
  ) {
    this.baseProvider = options.baseProvider;
    this.getCurrentSessionPath = options.getCurrentSessionPath;
    this.getCurrentCwd = options.getCurrentCwd;
    this.limit = options.limit ?? DEFAULT_AUTOCOMPLETE_LIMIT;
    this.deps = deps;
  }

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const handoffSuggestions = this.getHandoffSuggestions(lines, cursorLine, cursorCol);
    if (handoffSuggestions) {
      return handoffSuggestions;
    }

    this.resetHandoffState();
    return this.baseProvider.getSuggestions(lines, cursorLine, cursorCol);
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
  } {
    if (!this.specialItems.has(item)) {
      return this.baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    }

    const line = lines[cursorLine] ?? "";
    const start = Math.max(0, cursorCol - prefix.length);
    const nextLines = [...lines];
    nextLines[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
    this.resetHandoffState();

    return {
      lines: nextLines,
      cursorLine,
      cursorCol: start + item.value.length,
    };
  }

  getForceFileSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const handoffSuggestions = this.getHandoffSuggestions(lines, cursorLine, cursorCol);
    if (handoffSuggestions) {
      return handoffSuggestions;
    }

    const provider = this.baseProvider as ForceAutocompleteProvider;
    return provider.getForceFileSuggestions?.(lines, cursorLine, cursorCol) ?? null;
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    const line = lines[cursorLine] ?? "";
    if (detectHandoffPrefix(line, cursorCol)) {
      return true;
    }

    const provider = this.baseProvider as ForceAutocompleteProvider;
    return provider.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
  }

  toggleIncludeAllSessions(): boolean {
    if (!this.canToggleIncludeAllSessions()) {
      return this.includeAllSessions;
    }

    this.includeAllSessions = !this.includeAllSessions;
    return this.includeAllSessions;
  }

  clearIncludeAllSessions(): void {
    this.resetHandoffState();
  }

  isShowingAllSessions(): boolean {
    return this.autocompleteMode === "all";
  }

  isShowingHandoffSuggestions(): boolean {
    return this.hasActiveHandoffSuggestions;
  }

  canToggleIncludeAllSessions(): boolean {
    return true;
  }

  getDefaultScopeLabel(): string | undefined {
    return this.defaultScopeLabel;
  }

  private getHandoffSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const line = lines[cursorLine] ?? "";
    const prefix = detectHandoffPrefix(line, cursorCol);
    if (!prefix) {
      return null;
    }

    const result = this.deps.listCandidates({
      currentSessionPath: this.getCurrentSessionPath(),
      currentCwd: this.getCurrentCwd(),
      prefix: prefix.sessionIdPrefix,
      includeAll: this.includeAllSessions,
      limit: this.limit,
    });
    this.hasActiveHandoffSuggestions = true;
    this.autocompleteMode = result.mode;
    this.defaultScopeLabel = result.defaultScopeLabel;

    if (result.candidates.length === 0) {
      return null;
    }

    return {
      items: result.candidates.map((candidate) => this.trackCandidate(candidate)),
      prefix: prefix.raw,
    };
  }

  private trackCandidate(candidate: HandoffAutocompleteCandidate): AutocompleteItem {
    const item: AutocompleteItem = candidate.description
      ? { value: candidate.value, label: candidate.label, description: candidate.description }
      : { value: candidate.value, label: candidate.label };
    this.specialItems.add(item);
    return item;
  }

  private resetHandoffState(): void {
    this.includeAllSessions = false;
    this.hasActiveHandoffSuggestions = false;
    this.autocompleteMode = undefined;
    this.defaultScopeLabel = undefined;
  }
}

export class HandoffAutocompleteEditor extends CustomEditor {
  private readonly options: HandoffAutocompleteEditorOptions;
  private readonly deps: HandoffAutocompleteDeps;
  private handoffProvider?: HandoffAutocompleteProvider | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    options: HandoffAutocompleteEditorOptions,
    deps: HandoffAutocompleteDeps = defaultDeps,
  ) {
    super(tui, theme, keybindings);
    this.options = options;
    this.deps = deps;
  }

  override setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.handoffProvider = new HandoffAutocompleteProvider(
      {
        baseProvider: provider,
        getCurrentSessionPath: this.options.getCurrentSessionPath,
        getCurrentCwd: this.options.getCurrentCwd,
        limit: this.options.limit,
      },
      this.deps,
    );

    super.setAutocompleteProvider(this.handoffProvider);
  }

  override handleInput(data: string): void {
    if (
      this.handoffProvider &&
      this.isShowingAutocomplete() &&
      this.handoffProvider.isShowingHandoffSuggestions() &&
      this.handoffProvider.canToggleIncludeAllSessions() &&
      matchesKey(data, "alt+a")
    ) {
      this.handoffProvider.toggleIncludeAllSessions();
      refreshAutocomplete(this);
      this.syncAutocompleteStatus();
      return;
    }

    super.handleInput(data);

    if (!this.isShowingAutocomplete()) {
      this.handoffProvider?.clearIncludeAllSessions();
    }

    this.syncAutocompleteStatus();
  }

  private syncAutocompleteStatus(): void {
    if (
      !this.handoffProvider ||
      !this.isShowingAutocomplete() ||
      !this.handoffProvider.isShowingHandoffSuggestions()
    ) {
      this.options.setAutocompleteStatus(undefined);
      return;
    }

    this.options.setAutocompleteStatus(
      this.handoffProvider.isShowingAllSessions()
        ? `Alt+A: show ${this.handoffProvider.getDefaultScopeLabel() ?? "default"} sessions`
        : "Alt+A: show all sessions",
    );
  }
}

function refreshAutocomplete(editor: HandoffAutocompleteEditor): void {
  const updateAutocomplete = Reflect.get(editor, "updateAutocomplete");
  if (typeof updateAutocomplete === "function") {
    updateAutocomplete.call(editor);
  }
}
