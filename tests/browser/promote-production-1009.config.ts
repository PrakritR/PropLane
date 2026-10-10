import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "promote-production-1009/*.spec.ts",
  timeout: 120_000,
  workers: 1,
  retries: 0,
  use: { screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
