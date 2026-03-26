import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type FileTouchOp = "changed" | "read" | "touched";
export type FileTouchSource = "tool_call" | "branch_summary_details" | "compaction_details";
export type PathScope = "absolute" | "relative" | "basename";

export interface NormalizedPathRecord {
  rawPath: string;
  absPath?: string | undefined;
  cwdRelPath?: string | undefined;
  repoRoot?: string | undefined;
  repoRelPath?: string | undefined;
  basename: string;
  pathScope: PathScope;
  op?: FileTouchOp | undefined;
}

export function normalizePathRecord(rawPath: string, cwd: string): NormalizedPathRecord {
  const trimmedPath = rawPath.trim();
  const expandedPath = expandHome(trimmedPath);
  const pathScope = classifyPathScope(expandedPath);
  const absPath = resolveAbsolutePath(expandedPath, cwd);
  const repoRoot = absPath ? deriveRepoRootForPath(absPath) : undefined;

  return {
    rawPath: trimmedPath,
    absPath,
    cwdRelPath: absPath ? toRelativePath(absPath, cwd) : undefined,
    repoRoot,
    repoRelPath: absPath && repoRoot ? toRelativePath(absPath, repoRoot) : undefined,
    basename: deriveBasename(trimmedPath, absPath),
    pathScope,
  };
}

export function deriveRepoRootForPath(absPath: string): string | undefined {
  let current = path.normalize(absPath);

  while (true) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

export function deriveSessionRepoRoots(
  cwd: string,
  normalizedPaths: NormalizedPathRecord[],
): string[] {
  const repoRoots = new Set<string>();
  if (cwd && path.isAbsolute(cwd)) {
    const cwdRepoRoot = deriveRepoRootForPath(cwd);
    if (cwdRepoRoot) {
      repoRoots.add(cwdRepoRoot);
    }
  }

  for (const normalizedPath of normalizedPaths) {
    if (!normalizedPath.repoRoot || normalizedPath.op === "read") {
      continue;
    }

    repoRoots.add(normalizedPath.repoRoot);
  }

  return [...repoRoots].sort();
}

export function matchesRepoRoot(repoRoot: string, repoQuery: string): boolean {
  const normalizedRepoRoot = path.normalize(repoRoot);
  const normalizedQuery = normalizeSearchPath(repoQuery);
  if (!normalizedQuery) {
    return false;
  }

  if (path.isAbsolute(normalizedQuery) || normalizedQuery.includes("/")) {
    return normalizedRepoRoot === normalizedQuery || normalizedRepoRoot.endsWith(normalizedQuery);
  }

  return path.basename(normalizedRepoRoot) === normalizedQuery;
}

export function normalizeSearchPath(rawPath: string): string | undefined {
  const trimmedPath = rawPath.trim();
  if (!trimmedPath) {
    return undefined;
  }

  const expandedPath = expandHome(trimmedPath);
  return path.normalize(expandedPath).replace(/\\/g, "/");
}

function classifyPathScope(rawPath: string): PathScope {
  if (path.isAbsolute(rawPath)) {
    return "absolute";
  }

  if (rawPath.includes("/") || rawPath.includes("\\") || rawPath === "." || rawPath === "..") {
    return "relative";
  }

  return "basename";
}

function expandHome(rawPath: string): string {
  if (rawPath === "~") {
    return os.homedir();
  }

  if (rawPath.startsWith(`~${path.sep}`) || rawPath.startsWith("~/")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }

  return rawPath;
}

function resolveAbsolutePath(rawPath: string, cwd: string): string | undefined {
  if (!cwd || !path.isAbsolute(cwd)) {
    return path.isAbsolute(rawPath) ? normalizeAbsolute(rawPath) : undefined;
  }

  if (path.isAbsolute(rawPath)) {
    return normalizeAbsolute(rawPath);
  }

  return normalizeAbsolute(path.resolve(cwd, rawPath));
}

function normalizeAbsolute(absPath: string): string {
  return path.normalize(absPath).replace(/\\/g, "/");
}

function toRelativePath(absPath: string, root: string): string | undefined {
  if (!root || !path.isAbsolute(root)) {
    return undefined;
  }

  const normalizedAbsPath = normalizeAbsolute(absPath);
  const normalizedRoot = normalizeAbsolute(root);
  if (!isWithinPath(normalizedAbsPath, normalizedRoot)) {
    return undefined;
  }

  const relativePath = path.relative(normalizedRoot, normalizedAbsPath).replace(/\\/g, "/");
  return relativePath || ".";
}

function isWithinPath(targetPath: string, basePath: string): boolean {
  if (targetPath === basePath) {
    return true;
  }

  return targetPath.startsWith(`${basePath}/`);
}

function deriveBasename(rawPath: string, absPath?: string): string {
  const targetPath = absPath ?? rawPath;
  const normalizedPath = targetPath.replace(/[\\/]+$/, "");
  const basename = path.basename(normalizedPath);
  return basename || rawPath;
}
