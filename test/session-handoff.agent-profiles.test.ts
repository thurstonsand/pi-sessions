import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadAgentProfiles,
  parseAgentProfile,
  requireAgentProfile,
} from "../extensions/session-handoff/agent-profiles.ts";

describe("agent profiles", () => {
  it("parses a Claude Code subagent file into a profile", () => {
    const profile = parseAgentProfile(
      "/agents/oracle.md",
      [
        "---",
        "name: oracle",
        "description: >-",
        "  Read-only second opinion.",
        "  Use for reviews.",
        "model: anthropic/claude-fable-5-1:high",
        "thinkingLevel: xhigh",
        "tools: read, grep ,find",
        "color: purple",
        "---",
        "",
        "You review. You do not edit.",
        "",
      ].join("\n"),
    );

    expect(profile).toEqual({
      name: "oracle",
      description: "Read-only second opinion. Use for reviews.",
      model: "anthropic/claude-fable-5-1:high",
      thinkingLevel: "xhigh",
      tools: ["read", "grep", "find"],
      instructions: "You review. You do not edit.",
    });
  });

  it("leaves model, thinking level, and tools to the launch when unset", () => {
    const profile = parseAgentProfile(
      "/agents/scout.md",
      "---\nname: scout\ndescription: Looks around.\n---\nScout it.\n",
    );

    expect(profile).toMatchObject({ model: undefined, thinkingLevel: undefined, tools: undefined });
  });

  it.each([
    [
      "a name that differs from the file",
      "name: other\ndescription: d",
      "must match the file name",
    ],
    ["a missing description", "name: oracle", "required properties description"],
    [
      "an unknown thinking level",
      "name: oracle\ndescription: d\nthinkingLevel: huge",
      "/thinkingLevel",
    ],
    ["an empty tool list", "name: oracle\ndescription: d\ntools: ' , '", "at least one tool"],
  ])("rejects %s", (_case, frontmatter, message) => {
    expect(() =>
      parseAgentProfile("/agents/oracle.md", `---\n${frontmatter}\n---\nBody\n`),
    ).toThrow(message);
  });

  it("rejects a profile without instructions", () => {
    expect(() =>
      parseAgentProfile("/agents/oracle.md", "---\nname: oracle\ndescription: d\n---\n\n"),
    ).toThrow("instructions");
  });

  it("reports why a named profile is unusable instead of falling back", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sessions-agents-"));
    writeFileSync(join(dir, "oracle.md"), "---\nname: oracle\n---\nReview it.\n");
    writeFileSync(join(dir, "scout.md"), "---\nname: scout\ndescription: Looks.\n---\nScout.\n");
    writeFileSync(join(dir, "notes.txt"), "not a profile");

    const catalog = loadAgentProfiles(dir);

    expect(catalog.profiles.map((profile) => profile.name)).toEqual(["scout"]);
    expect(() => requireAgentProfile(catalog, "oracle")).toThrow(
      `Agent profile "oracle" is invalid: ${join(dir, "oracle.md")}: frontmatter: / must have required properties description`,
    );
    expect(() => requireAgentProfile(catalog, "critic")).toThrow(
      'Unknown agent profile "critic". Available agent profiles: scout.',
    );
  });

  it("treats a missing profiles directory as no profiles", () => {
    expect(loadAgentProfiles(join(tmpdir(), "pi-sessions-no-such-agents-dir")).profiles).toEqual(
      [],
    );
  });
});
