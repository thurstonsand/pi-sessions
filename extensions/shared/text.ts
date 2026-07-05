export function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(isTextBlock)
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function truncateInline(value: string, maxChars: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxChars)}…`;
}

export function truncateBlock(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }

  return {
    text: `${value.slice(0, maxChars)}\n\n[truncated to ${maxChars} characters]`,
    truncated: true,
  };
}

interface TextBlock {
  type: "text";
  text: string;
}

function isTextBlock(part: unknown): part is TextBlock {
  return isRecord(part) && part.type === "text" && typeof part.text === "string";
}
