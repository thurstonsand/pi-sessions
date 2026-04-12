export const SEARCH_SNIPPET_MATCH_START = "__PI_MATCH_START__";
export const SEARCH_SNIPPET_MATCH_END = "__PI_MATCH_END__";
export const SEARCH_SNIPPET_ELLIPSIS = " … ";

export function transformSearchSnippetMatches(
  snippet: string | undefined,
  transformMatch: (match: string) => string,
): string | undefined {
  if (!snippet) {
    return undefined;
  }

  let result = "";
  let offset = 0;

  while (offset < snippet.length) {
    const start = snippet.indexOf(SEARCH_SNIPPET_MATCH_START, offset);
    if (start < 0) {
      result += snippet.slice(offset);
      return result;
    }

    result += snippet.slice(offset, start);
    const matchStart = start + SEARCH_SNIPPET_MATCH_START.length;
    const end = snippet.indexOf(SEARCH_SNIPPET_MATCH_END, matchStart);
    if (end < 0) {
      result += snippet.slice(start);
      return result;
    }

    result += transformMatch(snippet.slice(matchStart, end));
    offset = end + SEARCH_SNIPPET_MATCH_END.length;
  }

  return result;
}

export function stripSearchSnippetMarkers(snippet: string | undefined): string | undefined {
  return transformSearchSnippetMatches(snippet, (match) => match);
}
