import { defineConfig } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";

const E2E_DIR = "/tmp/agent-room-e2e";
// Test-only database; never point this at the real profile or production data.
rmSync(E2E_DIR, { recursive: true, force: true });
mkdirSync(E2E_DIR, { recursive: true });

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node apps/server/dist/main.js",
      url: "http://127.0.0.1:8787/healthz",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...(process.env as Record<string, string>),
        AUTH_MODE: "dev",
        HOST: "127.0.0.1",
        PORT: "8787",
        DATABASE_PATH: `${E2E_DIR}/room.db`,
        BOOTSTRAP_OWNER_EMAIL: "owner@example.com",
      },
    },
    {
      command: "pnpm --filter @room/web dev --host 127.0.0.1 --port 5173",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
