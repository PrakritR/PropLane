import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "lane-merge-1008/*.spec.ts",
  timeout: 90_000,
  workers: 1,
  retries: 0,
  use: { screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
