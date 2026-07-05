import { type SearchQueryNode, SearchQuerySyntaxError } from "./ast.ts";
import { parseSearchQuery } from "./parser.ts";

export interface CompiledSearchQuery {
  match: string;
  relaxedMatch?: string | undefined;
  excludes: string[];
  positiveTerms: string[];
}

export function compileSearchQuery(input: string): CompiledSearchQuery | undefined {
  const ast = parseSearchQuery(input);
  if (!ast) {
    return undefined;
  }

  const { positive, excludes } = splitTopLevelExcludes(ast);
  if (!positive) {
    throw new SearchQuerySyntaxError(
      "Negative-only searches are not supported yet. Add at least one positive search term.",
    );
  }

  validateNoNestedNegation(positive);
  for (const exclude of excludes) {
    validateNoNestedNegation(exclude);
  }

  const match = compilePositiveNode(positive);
  const relaxedMatch = compilePositiveNode(positive, "OR");

  return {
    match,
    relaxedMatch: relaxedMatch === match ? undefined : relaxedMatch,
    excludes: excludes.map((exclude) => compilePositiveNode(exclude)),
    positiveTerms: collectPositiveTerms(positive),
  };
}

interface SplitQuery {
  positive: SearchQueryNode | undefined;
  excludes: SearchQueryNode[];
}

function splitTopLevelExcludes(node: SearchQueryNode): SplitQuery {
  if (node.kind === "not") {
    return { positive: undefined, excludes: [node.child] };
  }

  if (node.kind !== "and") {
    return { positive: node, excludes: [] };
  }

  const positives: SearchQueryNode[] = [];
  const excludes: SearchQueryNode[] = [];

  for (const child of flattenAndChildren(node)) {
    if (child.kind === "not") {
      excludes.push(child.child);
      continue;
    }

    positives.push(child);
  }

  return {
    positive: buildAndNode(positives),
    excludes,
  };
}

function flattenAndChildren(node: SearchQueryNode): SearchQueryNode[] {
  if (node.kind !== "and") {
    return [node];
  }

  return node.children.flatMap(flattenAndChildren);
}

function buildAndNode(children: SearchQueryNode[]): SearchQueryNode | undefined {
  if (children.length === 0) {
    return undefined;
  }

  if (children.length === 1) {
    return children[0];
  }

  return { kind: "and", children };
}

function validateNoNestedNegation(node: SearchQueryNode): void {
  switch (node.kind) {
    case "not":
      throw new SearchQuerySyntaxError(
        "Negation is only supported as a top-level AND clause in this release.",
      );
    case "and":
    case "or":
    case "adjacency":
      for (const child of node.children) {
        validateNoNestedNegation(child);
      }
      return;
    case "term":
      return;
  }
}

function compilePositiveNode(node: SearchQueryNode, adjacencyOp: "AND" | "OR" = "AND"): string {
  switch (node.kind) {
    case "term":
      return compileTerm(node.value, node.prefix);
    case "and":
      return `(${node.children.map((child) => compilePositiveNode(child, adjacencyOp)).join(" AND ")})`;
    case "or":
      return `(${node.children.map((child) => compilePositiveNode(child, adjacencyOp)).join(" OR ")})`;
    case "adjacency":
      return `(${node.children.map((child) => compileTerm(child.value, child.prefix)).join(` ${adjacencyOp} `)})`;
    case "not":
      throw new SearchQuerySyntaxError(
        "Negation is only supported as a top-level AND clause in this release.",
      );
  }
}

function compileTerm(value: string, prefix: boolean): string {
  return `${quoteFtsValue(value)}${prefix ? "*" : ""}`;
}

function quoteFtsValue(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function collectPositiveTerms(node: SearchQueryNode): string[] {
  switch (node.kind) {
    case "term":
      return [node.value];
    case "and":
    case "or":
    case "adjacency":
      return node.children.flatMap(collectPositiveTerms);
    case "not":
      return [];
  }
}
