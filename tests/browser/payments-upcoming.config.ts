import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "payments-upcoming/payments.spec.ts",
  timeout: 60_000,
  workers: 1,
  retries: 0,
  use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
