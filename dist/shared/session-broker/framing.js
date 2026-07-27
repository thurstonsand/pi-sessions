import { createInterface } from "node:readline";
const MAX_FRAME_BYTES = 256 * 1024;
export function writeFrame(socket, frame) {
    socket.write(`${JSON.stringify(frame)}\n`);
}
// The parser is injected so the detached broker can run with no dependencies
// installed alongside it, while Pi-side callers keep using TypeBox schemas.
export async function* readFrames(socket, parseFrame) {
    const reader = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    const lines = [];
    const waiters = [];
    let error;
    let closed = false;
    const wake = () => {
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
                await new Promise((resolve) => waiters.push(resolve));
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
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch (parseError) {
                throw parseError instanceof Error ? parseError : new Error(String(parseError));
            }
            yield parseFrame(parsed);
        }
    }
    finally {
        reader.close();
    }
}
