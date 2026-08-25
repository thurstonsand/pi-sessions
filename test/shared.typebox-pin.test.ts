import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Pi hands extensions its own bundled typebox as a virtual module, so the copy in
// this repo is only ever a typechecking stand-in for the one that actually runs.
// A skew between them is invisible at runtime and shows up as schemas that
// typecheck here and misbehave under pi, so pin it and let this test say when the
// pin goes stale: bump `typebox` to whatever pi's next release depends on.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(packageRoot, path), "utf8")) as T;
}

describe("typebox pin", () => {
  const piPinnedVersion = readJson<{ dependencies: { typebox: string } }>(
    "node_modules/@earendil-works/pi-coding-agent/package.json",
  ).dependencies.typebox;

  it("installs the same typebox pi bundles", () => {
    const installed = readJson<{ version: string }>("node_modules/typebox/package.json");
    expect(installed.version).toBe(piPinnedVersion);
  });

  it("declares that version exactly, so npm update cannot float off it", () => {
    const local = readJson<{ devDependencies: { typebox: string } }>("package.json");
    expect(local.devDependencies.typebox).toBe(piPinnedVersion);
  });
});
