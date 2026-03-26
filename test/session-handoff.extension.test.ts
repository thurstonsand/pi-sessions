import { describe, expect, it, vi } from "vitest";
import sessionHandoffExtension from "../extensions/session-handoff.js";

describe("session handoff extension", () => {
  it("registers prompt-editor integration on session lifecycle events", async () => {
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
    const registerCommand = vi.fn();
    const pi = {
      registerCommand,
      on(event: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown>) {
        handlers.set(event, handler);
      },
    };

    sessionHandoffExtension(pi as never);

    expect(registerCommand).toHaveBeenCalledWith(
      "handoff",
      expect.objectContaining({ description: "Transfer context to a new focused session" }),
    );

    const sessionStartHandler = handlers.get("session_start");
    const sessionSwitchHandler = handlers.get("session_switch");
    const sessionForkHandler = handlers.get("session_fork");
    const beforeAgentStartHandler = handlers.get("before_agent_start");
    expect(sessionStartHandler).toBeDefined();
    expect(sessionSwitchHandler).toBeDefined();
    expect(sessionForkHandler).toBeDefined();
    expect(beforeAgentStartHandler).toBeDefined();

    const setEditorComponent = vi.fn();
    const setWidget = vi.fn();
    const editorContext = {
      hasUI: true,
      ui: { setEditorComponent, setWidget },
      sessionManager: { getSessionFile: () => "/tmp/current.jsonl" },
    };
    await sessionStartHandler?.({}, editorContext);
    await sessionSwitchHandler?.({}, editorContext);
    await sessionForkHandler?.({}, editorContext);
    expect(setEditorComponent).toHaveBeenCalledTimes(3);
    expect(setWidget).toHaveBeenCalledWith("pi-sessions.session-autocomplete", undefined);

    await expect(beforeAgentStartHandler?.({})).resolves.toEqual({
      systemPrompt:
        "When the user references @session:<uuid>, treat it as a session token. If you call session_ask, pass only the UUID value, not the @session: prefix.",
    });
  });
});
