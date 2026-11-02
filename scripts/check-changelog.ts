import { readFileSync } from "node:fs";

// Usage: node scripts/check-changelog.ts [X.Y.Z]
// With a version, which release.yml passes from the tag, package.json must carry it too.

const RELEASED = /^## \[(\d+)\.(\d+)\.(\d+)\] - \d{4}-\d{2}-\d{2}$/;
const UNRELEASED = "## [Unreleased]";

const changelog = readFileSync("CHANGELOG.md", "utf8").split("\n");
const packageVersion: string = JSON.parse(readFileSync("package.json", "utf8")).version;
const expectedVersion = process.argv[2];

const errors: string[] = [];
const versions: { version: number[]; line: number }[] = [];

changelog.forEach((text, index) => {
  if (!text.startsWith("## ")) return;
  const line = index + 1;
  if (text === UNRELEASED) {
    if (versions.length > 0)
      errors.push(`line ${line}: ${UNRELEASED} must come before every release`);
    return;
  }
  const match = RELEASED.exec(text);
  if (!match) {
    errors.push(`line ${line}: "${text}" is neither ${UNRELEASED} nor "## [X.Y.Z] - YYYY-MM-DD"`);
    return;
  }
  const version = match.slice(1, 4).map(Number);
  const previous = versions.at(-1);
  if (previous && compare(version, previous.version) >= 0) {
    errors.push(
      `line ${line}: ${version.join(".")} does not come before ${previous.version.join(".")} (line ${previous.line})`,
    );
  }
  versions.push({ version, line });
});

const top = versions[0]?.version.join(".");
if (top !== packageVersion) {
  errors.push(`the newest release is ${top ?? "missing"}, but package.json says ${packageVersion}`);
}
if (expectedVersion !== undefined && expectedVersion !== packageVersion) {
  errors.push(`releasing ${expectedVersion}, but package.json says ${packageVersion}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`CHANGELOG.md: ${error}`);
  process.exit(1);
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
