export function isExactSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function shortenSessionId(sessionId: string): string {
  return isExactSessionId(sessionId) ? sessionId.slice(0, 8) : sessionId;
}

export function formatSessionTitleOrShortId(
  sessionName: string | undefined,
  sessionId: string | undefined,
): string {
  const title = sessionName?.trim();
  return title && title.length > 0 ? title : shortenSessionId(sessionId ?? "");
}
