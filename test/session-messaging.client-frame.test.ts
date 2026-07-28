import { describe, expect, test } from "vitest";
import { parseClientFrame } from "../extensions/session-messaging/broker/client-frame.ts";
import { CLIENT_FRAME_SCHEMA } from "../extensions/shared/session-broker/protocol.ts";
import { isTypeBoxValue } from "../extensions/shared/typebox.ts";

interface SchemaVariant {
  type: string;
  properties: Record<string, { type?: string; const?: string }>;
  required: string[];
}

const SAMPLE_FRAMES: Record<string, Record<string, unknown>> = {
  register: { type: "register", sessionId: "11111111-1111-4111-8111-111111111111" },
  unregister: { type: "unregister" },
  list: { type: "list", requestId: "req-1" },
  send: {
    type: "send",
    requestId: "req-2",
    target: "22222222-2222-4222-8222-222222222222",
    envelope: {
      kind: "message",
      messageId: "msg-1",
      body: "hello",
      sentAt: "2026-07-27T00:00:00.000Z",
    },
  },
  incoming_ack: { type: "incoming_ack", requestId: "req-3", delivered: true, error: "nope" },
};

const WRONG_TYPED_VALUES: Record<string, unknown> = {
  string: 7,
  boolean: "true",
  object: "not-an-object",
};

const schemaVariants = readSchemaVariants();

function readSchemaVariants(): SchemaVariant[] {
  const union = CLIENT_FRAME_SCHEMA as unknown as { anyOf: SchemaVariant[] };
  return union.anyOf.map((variant) => ({
    type: String(variant.properties.type?.const),
    properties: variant.properties,
    required: variant.required,
  }));
}

function requireSample(type: string): Record<string, unknown> {
  const sample = SAMPLE_FRAMES[type];
  if (!sample) {
    throw new Error(`No broker sample frame for schema variant: ${type}`);
  }

  return sample;
}

function schemaAccepts(frame: unknown): boolean {
  return isTypeBoxValue(CLIENT_FRAME_SCHEMA, frame);
}

function brokerAccepts(frame: unknown): boolean {
  try {
    parseClientFrame(frame);
    return true;
  } catch {
    return false;
  }
}

function omit(frame: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = frame;
  return rest;
}

test("every client frame variant in the schema has a broker sample", () => {
  expect(schemaVariants.map((variant) => variant.type).sort()).toEqual(
    Object.keys(SAMPLE_FRAMES).sort(),
  );
});

describe.each(schemaVariants)("$type client frame", (variant) => {
  const sample = requireSample(variant.type);

  test("both parsers accept the sample and the broker preserves it", () => {
    expect(schemaAccepts(sample)).toBe(true);
    expect(parseClientFrame(sample)).toEqual(sample);
  });

  test.each(variant.required)("both parsers reject a frame missing %s", (required) => {
    const frame = omit(sample, required);
    expect(schemaAccepts(frame)).toBe(false);
    expect(brokerAccepts(frame)).toBe(false);
  });

  test.each(Object.entries(variant.properties))(
    "both parsers reject a wrong-typed %s",
    (property, declared) => {
      const wrongValue =
        declared.const === undefined
          ? WRONG_TYPED_VALUES[declared.type ?? "string"]
          : `not-${declared.const}`;
      const frame = { ...sample, [property]: wrongValue };
      expect(schemaAccepts(frame)).toBe(false);
      expect(brokerAccepts(frame)).toBe(false);
    },
  );
});

test("both parsers reject non-object frames", () => {
  for (const frame of [null, "register", 7, [], undefined]) {
    expect(schemaAccepts(frame)).toBe(false);
    expect(brokerAccepts(frame)).toBe(false);
  }
});

// The broker routes envelopes without reading them, so it deliberately accepts
// bodies the schema rejects. The receiving client re-validates on arrival.
test("the broker treats envelope contents as opaque", () => {
  const frame = { ...SAMPLE_FRAMES.send, envelope: { kind: "not-a-real-kind" } };
  expect(schemaAccepts(frame)).toBe(false);
  expect(brokerAccepts(frame)).toBe(true);
});
