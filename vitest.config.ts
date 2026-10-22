import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import testing from "./config/testing.json" with { type: "json" };
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    fileParallelism: testing.file_parallelism,
    testTimeout: testing.timeout_ms,
    hookTimeout: testing.timeout_ms,
  },
});
