import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    maxWorkers: 2,
    environment: "node",
    include: ["src/**/*.test.ts", ".agents/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
