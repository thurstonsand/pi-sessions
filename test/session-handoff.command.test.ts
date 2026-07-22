import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOpenHandoffBoard = vi.fn();

vi.mock("../extensions/session-handoff/board.ts", async () => {
  const actual = await vi.importActual<object>("../extensions/session-handoff/board.ts");
  return { ...actual, openHandoffBoard: mockOpenHandoffBoard };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/handoff", () => {
  it("opens the handoff board without arguments", async () => {
    const command = await installCommand();
    const ctx = commandContext();

    await command.handler("", ctx);

    expect(mockOpenHandoffBoard).toHaveBeenCalledWith(ctx, {});
  });

  it("rejects launch arguments", async () => {
    const command = await installCommand();
    const ctx = commandContext();

    await command.handler("--right old launch path", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("/handoff does not accept arguments.", "error");
    expect(mockOpenHandoffBoard).not.toHaveBeenCalled();
  });

  it("requires interactive mode", async () => {
    const command = await installCommand();
    const ctx = commandContext({ mode: "rpc", hasUI: false });

    await command.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("handoff requires interactive mode", "error");
    expect(mockOpenHandoffBoard).not.toHaveBeenCalled();
  });
});

async function installCommand(): Promise<{
  handler(args: string, ctx: ReturnType<typeof commandContext>): Promise<void>;
}> {
  const { installHandoff } = await import("../extensions/session-handoff/install.ts");
  let command:
    | { handler(args: string, ctx: ReturnType<typeof commandContext>): Promise<void> }
    | undefined;
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((_name, definition) => {
      command = definition;
    }),
    registerShortcut: vi.fn(),
    on: vi.fn(),
    getThinkingLevel: vi.fn(),
  };

  installHandoff(pi as never, {
    settings: {
      handoff: {
        pickerShortcut: "alt+o",
        persistRuns: false,
        deferred: { copyToClipboard: true },
      },
    } as never,
    index: { path: "/tmp/index.sqlite" },
    getModelRuntime: vi.fn(),
    board: {},
  });

  if (!command) {
    throw new Error("handoff command was not registered");
  }
  return command;
}

function commandContext(overrides: { mode?: string; hasUI?: boolean } = {}) {
  return {
    mode: overrides.mode ?? "tui",
    hasUI: overrides.hasUI ?? true,
    cwd: "/repo",
    ui: {
      notify: vi.fn(),
      custom: vi.fn(),
    },
    sessionManager: {
      getEntries: () => [],
    },
  };
}
