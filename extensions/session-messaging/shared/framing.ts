import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import type { Static, TSchema } from "typebox";
import { parseTypeBoxValue } from "../../shared/typebox.ts";

const MAX_FRAME_BYTES = 256 * 1024;

export function writeFrame<T>(socket: Socket, frame: T): void {
  socket.write(`${JSON.stringify(frame)}\n`);
}

export async function* readFrames<T extends TSchema>(
  socket: Socket,
  schema: T,
  context: string,
): AsyncGenerator<Static<T>> {
  const reader = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
  const lines: string[] = [];
  const waiters: Array<() => void> = [];
  let error: Error | undefined;
  let closed = false;

  const wake = (): void => {
    const waiter = waiters.shift();
    waiter?.();
  };

  reader.on("line", (line) => {
    lines.push(line);
    wake();
  });
  reader.on("error", (nextError) => {
    error = nextError instanceof Error ? nextError : new Error(String(nextError));
    closed = true;
    wake();
  });
  reader.on("close", () => {
    closed = true;
    wake();
  });

  try {
    while (true) {
      while (lines.length === 0 && !closed) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }

      const line = lines.shift();
      if (line === undefined) {
        if (error) {
          throw error;
        }
        return;
      }

      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
        throw new Error("Session messaging frame exceeds maximum size.");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (parseError) {
        throw parseError instanceof Error ? parseError : new Error(String(parseError));
      }

      yield parseTypeBoxValue(schema, parsed, context);
    }
  } finally {
    reader.close();
  }
}
