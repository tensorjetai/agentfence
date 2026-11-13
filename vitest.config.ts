import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@agentfence/analyzer": fileURLToPath(
        new URL("./packages/analyzer/src/index.ts", import.meta.url),
      ),
      "@agentfence/policy": fileURLToPath(
        new URL("./packages/policy/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/**/*.test.ts"],
    coverage: { reporter: ["text", "json-summary"] },
  },
});
