import { SearchQuerySyntaxError } from "./ast.ts";

export type QueryToken =
  | { kind: "term"; value: string; quoted: boolean; prefix: boolean; offset: number }
  | { kind: "and"; offset: number }
  | { kind: "or"; offset: number }
  | { kind: "not"; offset: number }
  | { kind: "leftParen"; offset: number }
  | { kind: "rightParen"; offset: number };

export function lexSearchQuery(input: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (isWhitespace(char)) {
      index += 1;
      continue;
    }

    if (char === "(") {
      tokens.push({ kind: "leftParen", offset: index });
      index += 1;
      continue;
    }

    if (char === ")") {
      tokens.push({ kind: "rightParen", offset: index });
      index += 1;
      continue;
    }

    if (char === '"') {
      const token = readQuotedTerm(input, index);
      tokens.push(token.token);
      index = token.nextIndex;
      continue;
    }

    if (char === "-" && isNegationBoundary(input, index)) {
      tokens.push({ kind: "not", offset: index });
      index += 1;
      continue;
    }

    const token = readUnquotedToken(input, index);
    tokens.push(token.token);
    index = token.nextIndex;
  }

  return tokens;
}

function readQuotedTerm(input: string, start: number): { token: QueryToken; nextIndex: number } {
  let index = start + 1;
  let value = "";

  while (index < input.length) {
    const char = input[index];
    if (char === '"') {
      const afterQuote = index + 1;
      const hasPrefix = input[afterQuote] === "*";
      if (value.length === 0) {
        throw new SearchQuerySyntaxError(`Empty quoted term at offset ${start}`);
      }
      return {
        token: { kind: "term", value, quoted: true, prefix: hasPrefix, offset: start },
        nextIndex: hasPrefix ? afterQuote + 1 : afterQuote,
      };
    }

    value += char;
    index += 1;
  }

  throw new SearchQuerySyntaxError(`Unclosed quote at offset ${start}`);
}

function readUnquotedToken(input: string, start: number): { token: QueryToken; nextIndex: number } {
  let index = start;
  let value = "";

  while (index < input.length) {
    const char = input[index];
    if (isWhitespace(char) || char === "(" || char === ")" || char === '"') {
      break;
    }

    value += char;
    index += 1;
  }

  if (value.length === 0) {
    throw new SearchQuerySyntaxError(`Unexpected character at offset ${start}`);
  }

  const upper = value.toUpperCase();
  if (upper === "AND") {
    return { token: { kind: "and", offset: start }, nextIndex: index };
  }
  if (upper === "OR") {
    return { token: { kind: "or", offset: start }, nextIndex: index };
  }
  if (upper === "NOT") {
    return { token: { kind: "not", offset: start }, nextIndex: index };
  }

  const firstStar = value.indexOf("*");
  if (firstStar >= 0 && firstStar !== value.length - 1) {
    throw new SearchQuerySyntaxError(`Only trailing * is supported at offset ${start}`);
  }

  const hasPrefix = value.endsWith("*");
  const termValue = hasPrefix ? value.slice(0, -1) : value;
  if (termValue.length === 0) {
    throw new SearchQuerySyntaxError(`Empty prefix term at offset ${start}`);
  }

  return {
    token: { kind: "term", value: termValue, quoted: false, prefix: true, offset: start },
    nextIndex: index,
  };
}

function isNegationBoundary(input: string, index: number): boolean {
  if (index > 0) {
    const previous = input[index - 1];
    if (!isWhitespace(previous) && previous !== "(") {
      return false;
    }
  }

  const next = input[index + 1];
  return next !== undefined && !isWhitespace(next) && next !== ")";
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/.test(value);
}
