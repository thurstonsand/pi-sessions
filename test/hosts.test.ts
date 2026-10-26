import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { HostRegistrationRequest } from "../extensions/hosts/contract.ts";
import { HostRegistry } from "../extensions/hosts/registry.ts";
import { installAsk } from "../extensions/session-ask/install.ts";
import type { SessionDirectory } from "../extensions/session-messaging/directory.ts";
import { installDirectoryTools } from "../extensions/session-messaging/pi/install.ts";
import { installSearch } from "../extensions/session-search/install.ts";
import { loadSettings } from "../extensions/shared/settings.ts";
import { createFakeExtensionApi } from "./test-helpers.ts";

describe("recall claims", () => {
  it.each(["search", "ask"] as const)(
    "defers %s, preserves host tools, guards retained definitions and restores standalone recall",
    async (kind) => {
      const pi = createFakeExtensionApi();
      const name = `session_${kind}`;
      let active = [name, "subagent_launch"];
      let claimed = true;
      const definitions: ToolDefinition[] = [];
      vi.mocked(pi.getActiveTools).mockImplementation(() => active);
      vi.mocked(pi.setActiveTools).mockImplementation((tools) => {
        active = tools;
      });
      vi.mocked(pi.registerTool).mockImplementation((tool) => {
        definitions.push(tool);
      });
      const deps = {
        settings: loadSettings(),
        index: { path: "/unused" },
        claimsRecall: () => claimed,
        getModelRuntime: () => ({}) as never,
      };
      const installed = kind === "search" ? installSearch(pi, deps) : installAsk(pi, deps);
      expect(definitions).toHaveLength(0);
      installed.refresh();
      expect(definitions).toHaveLength(0);
      expect(active).toEqual([name, "subagent_launch"]);
      claimed = false;
      installed.refresh();
      installed.refresh();
      expect(definitions).toHaveLength(1);
      expect(active).toEqual([name, "subagent_launch"]);
      const tool = definitions[0];
      if (!tool) throw new Error("Standalone recall tool was not registered.");
      // Invalid input reaches the standalone implementation, not the host guard.
      const params = kind === "search" ? { limit: 0 } : { session: "", question: "why?" };
      await expect(tool.execute("test", params, undefined, undefined, {} as never)).rejects.toThrow(
        kind === "search" ? "limit must be greater than 0" : "requires a session id",
      );
      claimed = true;
      installed.refresh();
      expect(active).toEqual(["subagent_launch"]);
      await expect(tool.execute("test", params, undefined, undefined, {} as never)).rejects.toThrow(
        "Recall tools belong to the current host",
      );
      claimed = false;
      installed.refresh();
      expect(active).toEqual(["subagent_launch", name]);
      expect(definitions).toHaveLength(1);
    },
  );

  it("accepts recall independently of a legacy peer-only claim and resets it on discovery", () => {
    const events = createEventBus();
    const registry = new HostRegistry();
    const off = events.on("pi-sessions:hosts", (value) => {
      (value as HostRegistrationRequest).register({ name: "swb", peers: true, recall: true });
    });
    registry.discover(events);
    expect(registry.claimsRecall()).toBe(true);
    expect(registry.claimsPeers()).toBe(true);
    off();
    events.on("pi-sessions:hosts", (value) => {
      (value as HostRegistrationRequest).register({ name: "legacy", peers: true });
    });
    registry.discover(events);
    expect(registry.claimsRecall()).toBe(false);
    expect(registry.claimsPeers()).toBe(true);
  });
});

describe("peer claims", () => {
  it("leaves host tools intact, deactivates retained peer definitions and restores standalone tools", async () => {
    const pi = createFakeExtensionApi();
    let active = ["session_reachable", "session_send_message", "session_cancel", "session_launch"];
    let claimed = true;
    const definitions = new Map<string, ToolDefinition>();
    vi.mocked(pi.getActiveTools).mockImplementation(() => active);
    vi.mocked(pi.setActiveTools).mockImplementation((tools) => {
      active = tools;
    });
    vi.mocked(pi.registerTool).mockImplementation((tool) => {
      definitions.set(tool.name, tool);
    });
    const directory: SessionDirectory = {
      list: async () => [],
      resolve: vi.fn(),
      send: vi.fn(),
      cancel: vi.fn(),
      wake: vi.fn(),
      getRelationTo: () => undefined,
      getParentSessionId: () => undefined,
    };
    const installed = installDirectoryTools(pi, {
      peers: directory,
      subagents: directory,
      claimsPeers: () => claimed,
    });
    expect(definitions.size).toBe(0);
    installed.refresh();
    expect(active).toContain("session_send_message"); // host's load-time tool, not ours
    expect([...definitions.keys()]).toEqual(["subagent_list", "subagent_send", "subagent_cancel"]);
    claimed = false;
    installed.refresh();
    expect(active).toContain("session_reachable");
    const peer = definitions.get("session_reachable");
    if (!peer) throw new Error("Standalone peer tool was not registered.");
    expect((await peer.execute("list", {}, undefined, undefined, {} as never)).details).toEqual({
      scope: "user",
      sessions: [],
    });
    claimed = true;
    installed.refresh();
    expect(active).not.toContain("session_reachable");
    expect(active).toContain("subagent_list");
    await expect(peer.execute("list", {}, undefined, undefined, {} as never)).rejects.toThrow(
      "current host",
    );
    claimed = false;
    installed.refresh();
    expect(active).toContain("session_reachable");
  });

  it("freezes synchronous registration and rediscovers on every session", () => {
    const events = createEventBus();
    let request: HostRegistrationRequest | undefined;
    const off = events.on("pi-sessions:hosts", (value) => {
      request = value as HostRegistrationRequest;
      request.register({ name: "swb", peers: true });
    });
    const registry = new HostRegistry();
    registry.discover(events);
    expect(registry.getHosts()).toEqual([{ name: "swb", peers: true }]);
    expect(registry.claimsPeers()).toBe(true);
    expect(() => request?.register({ name: "late", peers: true })).toThrow(
      "registration is closed",
    );
    off();
    registry.discover(events);
    expect(registry.claimsPeers()).toBe(false);
  });

  it.each([
    { name: "swb", peers: false },
    { name: "subagent", peers: true },
    { name: "Swb", peers: true },
    { name: "swb", peers: true, recall: false },
    { name: "swb", peers: true, launch: () => {} },
  ])("rejects invalid claims even when Pi swallows errors", (host) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const events = createEventBus();
      events.on("pi-sessions:hosts", (request) =>
        (request as HostRegistrationRequest).register(host as never),
      );
      expect(() => new HostRegistry().discover(events)).toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects duplicate names", () => {
    const events = createEventBus();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      events.on("pi-sessions:hosts", (request) => {
        const { register } = request as HostRegistrationRequest;
        register({ name: "swb", peers: true });
        register({ name: "swb", peers: true });
      });
      expect(() => new HostRegistry().discover(events)).toThrow("already registered");
    } finally {
      spy.mockRestore();
    }
  });
});
