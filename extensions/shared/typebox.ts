import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export function isTypeBoxValue<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
  return Value.Check(schema, value);
}

export function parseTypeBoxValue<T extends TSchema>(
  schema: T,
  value: unknown,
  context: string,
): Static<T> {
  if (Value.Check(schema, value)) {
    return value as Static<T>;
  }

  throw new Error(formatTypeBoxError(schema, value, context));
}

export function safeParseTypeBoxValue<T extends TSchema>(
  schema: T,
  value: unknown,
): Static<T> | undefined {
  return Value.Check(schema, value) ? (value as Static<T>) : undefined;
}

export function parseTypeBoxRows<T extends TSchema>(
  schema: T,
  value: unknown,
  context: string,
): Static<T>[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context}: expected an array of rows.`);
  }

  return value.map((row, index) =>
    parseTypeBoxValue(schema, row, `${context} at row ${index + 1}`),
  );
}

export function safeParseTypeBoxJson<T extends TSchema>(
  schema: T,
  raw: string,
): Static<T> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return safeParseTypeBoxValue(schema, parsed);
  } catch {
    return undefined;
  }
}

function formatTypeBoxError(schema: TSchema, value: unknown, context: string): string {
  const firstError = Value.Errors(schema, value).First();
  if (!firstError) {
    return `${context}: invalid value.`;
  }

  const path = firstError.path.length > 0 ? firstError.path : "/";
  return `${context}: ${path} ${firstError.message}`;
}
