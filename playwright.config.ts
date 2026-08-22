import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(__dirname, ".env.test") });
dotenv.config({ path: path.resolve(__dirname, ".env.local"), override: false });
dotenv.config({ path: path.resolve(__dirname, ".env"), override: false });

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const portalE2eEnabled = process.env.E2E_TESTS_ENABLED === "1";

const chromiumProject = {
  name: "chromium",
  testIgnore: /auth\.setup\.ts/,
  use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
} as const;

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Serial workers: parallel file execution overloads the local dev server and
  // causes auth/navigation flakes (sign-in never leaves /auth/sign-in).
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  // Hard suite-wide wall-clock cap so a broken run can never hang. Per-test
  // timeouts (60s) don't bound the whole suite: 131 specs run serially at
  // retries: 2, so a systemic failure (e.g. sign-in never succeeding) can burn
  // hours before GitHub's 6h job default. globalSetup fails such runs in seconds;
  // this is the backstop if a run degrades some other way. E2E has no measured
  // healthy runtime on main yet, so this is a deliberately generous cap kept
  // under the CI job's 30-min timeout-minutes, which is the hard backstop.
  globalTimeout: 40 * 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
    ? undefined
    : {
        command: "npm run build && npm run start",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
  projects: [
    ...(portalE2eEnabled
      ? [{ name: "setup", testMatch: /auth\.setup\.ts/ }, { ...chromiumProject, dependencies: ["setup"] as const }]
      : [chromiumProject]),
  ],
});
