import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSessionMessagingDir,
  getSessionMessagingSocketPath,
} from "../extensions/shared/session-broker/socket-path.ts";

const originalEnv = {
  PI_SESSIONS_MESSAGING_DIR: process.env.PI_SESSIONS_MESSAGING_DIR,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

beforeEach(() => {
  delete process.env.PI_SESSIONS_MESSAGING_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("getSessionMessagingDir", () => {
  it("defaults under ~/.pi/agent when no env vars are set", () => {
    expect(getSessionMessagingDir()).toBe(
      join(homedir(), ".pi", "agent", "pi-sessions", "messaging"),
    );
  });

  it("honors PI_CODING_AGENT_DIR", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/custom/agent-dir");
    expect(getSessionMessagingDir()).toBe(join("/custom/agent-dir", "pi-sessions", "messaging"));
  });

  it("prefers PI_SESSIONS_MESSAGING_DIR over PI_CODING_AGENT_DIR", () => {
    vi.stubEnv("PI_SESSIONS_MESSAGING_DIR", "/override/messaging");
    vi.stubEnv("PI_CODING_AGENT_DIR", "/custom/agent-dir");
    expect(getSessionMessagingDir()).toBe("/override/messaging");
  });
});

describe("getSessionMessagingSocketPath", () => {
  it("puts broker.sock inside the messaging dir", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/custom/agent-dir");
    expect(getSessionMessagingSocketPath("linux")).toBe(
      "/custom/agent-dir/pi-sessions/messaging/broker.sock",
    );
  });

  it("keeps the pipe name derived from the messaging dir on win32", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/custom/agent-dir");
    expect(getSessionMessagingSocketPath("win32")).toBe(
      "\\\\.\\pipe\\pi-sessions-messaging-custom-agent-dir-pi-sessions-messaging",
    );
  });
});
