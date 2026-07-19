export function formatError(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}
