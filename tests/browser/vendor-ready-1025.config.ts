import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "vendor-ready-1025/vendor-ready.spec.ts",
  timeout: 90_000,
  workers: 1,
  retries: 0,
  use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
