import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/smoke/*.smoke.ts"],
    testTimeout: 90_000,
    hookTimeout: 15_000,
  },
});
