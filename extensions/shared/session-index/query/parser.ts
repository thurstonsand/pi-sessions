import {
  type QueryAdjacencyNode,
  type QueryAndNode,
  type QueryNotNode,
  type QueryOrNode,
  type QueryTermNode,
  type SearchQueryNode,
  SearchQuerySyntaxError,
} from "./ast.ts";
import { lexSearchQuery, type QueryToken } from "./lexer.ts";

export function parseSearchQuery(input: string): SearchQueryNode | undefined {
  const tokens = lexSearchQuery(input);
  if (tokens.length === 0) {
    return undefined;
  }

  const parser = new Parser(tokens);
  return parser.parse();
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: QueryToken[]) {}

  parse(): SearchQueryNode {
    const node = this.parseOr();
    const token = this.peek();
    if (token) {
      throw new SearchQuerySyntaxError(`Unexpected token at offset ${token.offset}`);
    }
    return node;
  }

  private parseOr(): SearchQueryNode {
    const children = [this.parseAnd()];

    while (this.match("or")) {
      children.push(this.parseAnd());
    }

    return buildOrNode(children);
  }

  private parseAnd(): SearchQueryNode {
    const children = [this.parseAdjacencyRun()];

    while (true) {
      if (this.match("and")) {
        children.push(this.parseAdjacencyRun());
        continue;
      }

      if (this.startsUnary(this.peek())) {
        children.push(this.parseAdjacencyRun());
        continue;
      }

      break;
    }

    return buildAndNode(children);
  }

  private parseAdjacencyRun(): SearchQueryNode {
    const first = this.peek();
    if (!isUnquotedTerm(first)) {
      return this.parseUnary();
    }

    const children: QueryTermNode[] = [];
    while (true) {
      const token = this.peek();
      if (!isUnquotedTerm(token)) {
        break;
      }

      this.index += 1;
      children.push({
        kind: "term",
        value: token.value,
        quoted: token.quoted,
        prefix: token.prefix,
      });
    }

    return buildAdjacencyNode(children);
  }

  private parseUnary(): SearchQueryNode {
    const token = this.peek();
    if (token?.kind === "not") {
      this.index += 1;
      const child = this.parseUnary();
      return { kind: "not", child } satisfies QueryNotNode;
    }

    return this.parsePrimary();
  }

  private parsePrimary(): SearchQueryNode {
    const token = this.peek();
    if (!token) {
      throw new SearchQuerySyntaxError("Unexpected end of query");
    }

    if (token.kind === "term") {
      this.index += 1;
      return {
        kind: "term",
        value: token.value,
        quoted: token.quoted,
        prefix: token.prefix,
      } satisfies QueryTermNode;
    }

    if (token.kind === "leftParen") {
      this.index += 1;
      const node = this.parseOr();
      const next = this.peek();
      if (next?.kind !== "rightParen") {
        throw new SearchQuerySyntaxError(`Unclosed parenthesis at offset ${token.offset}`);
      }
      this.index += 1;
      return node;
    }

    throw new SearchQuerySyntaxError(`Expected term at offset ${token.offset}`);
  }

  private startsUnary(token: QueryToken | undefined): boolean {
    return token?.kind === "term" || token?.kind === "leftParen" || token?.kind === "not";
  }

  private match(kind: "and" | "or"): boolean {
    if (this.peek()?.kind !== kind) {
      return false;
    }

    this.index += 1;
    return true;
  }

  private peek(): QueryToken | undefined {
    return this.tokens[this.index];
  }
}

function buildAndNode(children: SearchQueryNode[]): SearchQueryNode {
  if (children.length === 1) {
    return children[0] as SearchQueryNode;
  }

  return { kind: "and", children } satisfies QueryAndNode;
}

function buildOrNode(children: SearchQueryNode[]): SearchQueryNode {
  if (children.length === 1) {
    return children[0] as SearchQueryNode;
  }

  return { kind: "or", children } satisfies QueryOrNode;
}

function buildAdjacencyNode(children: QueryTermNode[]): SearchQueryNode {
  if (children.length === 1) {
    return children[0] as SearchQueryNode;
  }

  return { kind: "adjacency", children } satisfies QueryAdjacencyNode;
}

function isUnquotedTerm(
  token: QueryToken | undefined,
): token is Extract<QueryToken, { kind: "term" }> {
  return token?.kind === "term" && !token.quoted;
}
