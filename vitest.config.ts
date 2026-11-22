import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolveWorkspace = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@room/config": resolveWorkspace("./packages/config/src/index.ts"),
      "@room/database": resolveWorkspace("./packages/database/src/index.ts"),
      "@room/protocol": resolveWorkspace("./packages/protocol/src/index.ts"),
    },
  },
});
