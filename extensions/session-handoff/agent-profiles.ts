import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatError } from "../shared/errors.ts";
import { THINKING_LEVELS } from "../shared/thinking-levels.ts";
import { parseTypeBoxValue } from "../shared/typebox.ts";

// Claude Code's subagent file format, so one file can serve several harnesses.
// Keys other harnesses define, such as Claude Code's `color`, are ignored.
const AGENT_PROFILE_FRONTMATTER_SCHEMA = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  model: Type.Optional(Type.String({ minLength: 1 })),
  thinkingLevel: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))),
  tools: Type.Optional(Type.String({ minLength: 1 })),
});

export interface AgentProfile {
  name: string;
  description: string;
  /** A Pi model pattern; a `:<thinking>` suffix travels with the model it names. */
  model: string | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  /** An allowlist for the child's `--tools`, or undefined to inherit every tool. */
  tools: readonly string[] | undefined;
  instructions: string;
}

export interface AgentProfileCatalog {
  profiles: readonly AgentProfile[];
  /** Validation errors by file name, so a launch naming a broken profile reports why. */
  invalid: ReadonlyMap<string, string>;
}

export const EMPTY_AGENT_PROFILE_CATALOG: AgentProfileCatalog = {
  profiles: [],
  invalid: new Map(),
};

export function loadAgentProfiles(dir: string): AgentProfileCatalog {
  let fileNames: string[];
  try {
    fileNames = readdirSync(dir)
      .filter((fileName) => fileName.endsWith(".md"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_AGENT_PROFILE_CATALOG;
    }
    throw error;
  }

  const profiles: AgentProfile[] = [];
  const invalid = new Map<string, string>();
  for (const fileName of fileNames) {
    const path = join(dir, fileName);
    try {
      profiles.push(parseAgentProfile(path, readFileSync(path, "utf8")));
    } catch (error) {
      invalid.set(basename(fileName, ".md"), `${path}: ${formatError(error)}`);
    }
  }
  return { profiles, invalid };
}

export function parseAgentProfile(path: string, content: string): AgentProfile {
  const { frontmatter, body } = parseFrontmatter(content);
  const fields = parseTypeBoxValue(AGENT_PROFILE_FRONTMATTER_SCHEMA, frontmatter, "frontmatter");
  const fileName = basename(path, ".md");
  if (fields.name !== fileName) {
    throw new Error(`name "${fields.name}" must match the file name "${fileName}".`);
  }
  const instructions = body.trim();
  if (!instructions) {
    throw new Error("the body must hold the profile's instructions.");
  }
  const tools = fields.tools
    ?.split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  if (tools?.length === 0) {
    throw new Error("tools must name at least one tool.");
  }

  return {
    name: fields.name,
    description: fields.description.replace(/\s+/g, " ").trim(),
    model: fields.model?.trim(),
    thinkingLevel: fields.thinkingLevel,
    tools,
    instructions,
  };
}

export function requireAgentProfile(catalog: AgentProfileCatalog, name: string): AgentProfile {
  const profile = catalog.profiles.find((candidate) => candidate.name === name);
  if (profile) {
    return profile;
  }
  const error = catalog.invalid.get(name);
  if (error) {
    throw new Error(`Agent profile "${name}" is invalid: ${error}`);
  }
  const available = catalog.profiles.map((candidate) => candidate.name).join(", ");
  throw new Error(
    `Unknown agent profile "${name}". Available agent profiles: ${available || "none"}.`,
  );
}
