import { chromium, type Browser } from "@playwright/test";
import { E2E_ACCOUNTS } from "./fixtures";

// Preflight for the portal E2E suite.
//
// When E2E_TESTS_ENABLED=1 the portal specs sign in as seeded accounts
// (admin/manager/resident) before asserting anything. If those accounts are not
// reachable — the E2E_* credential secrets are missing/blank, or the accounts
// were never seeded into the target Supabase project — every one of those specs
// stalls on `page.waitForURL(... 30s)` and, with 158 cases run serially, the
// whole job grinds for hours before GitHub's 6h default kills
// it. That is exactly how CI on `main` hung: the E2E_* repo secrets do not exist,
// so sign-in submitted empty credentials and never navigated.
//
// This preflight does one real sign-in per seeded role (admin, manager,
// resident) as a smoke check, each in a fresh browser context so sessions never
// carry over. It resolves credentials from the SAME `E2E_ACCOUNTS` the specs
// use, so it can never pass green while the specs sign in as someone else. If
// any role cannot complete within a short budget it throws immediately, naming
// the role, so a misconfigured suite fails in seconds with an actionable message
// instead of hanging. It is a no-op unless E2E_TESTS_ENABLED=1, so it never
// affects local runs that intentionally skip the portal specs.
const SMOKE_TIMEOUT_MS = 25_000;

const PREFLIGHT_ROLES = [
  { role: "admin", emailEnvVar: "E2E_ADMIN_EMAIL", next: "/admin/dashboard" },
  { role: "manager", emailEnvVar: "E2E_MANAGER_EMAIL", next: "/portal/dashboard" },
  { role: "resident", emailEnvVar: "E2E_RESIDENT_EMAIL", next: "/resident/dashboard" },
] as const;

async function smokeSignIn(
  browser: Browser,
  baseURL: string,
  next: string,
  email: string,
  password: string,
) {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}/auth/sign-in?next=${encodeURIComponent(next)}`, {
      waitUntil: "domcontentloaded",
      timeout: SMOKE_TIMEOUT_MS,
    });
    await page.getByPlaceholder("Email").fill(email);
    await page.getByPlaceholder("Password").fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();
    // Smoke check only: confirm the credentials authenticate. The exact landing
    // varies by account shape — a single-role account goes straight to its
    // portal, a multi-role account (a shipped feature) may pass through
    // /auth/continue or /auth/choose-portal — so assert only that we left the
    // sign-in page.
    await page.waitForURL((url) => url.pathname !== "/auth/sign-in", { timeout: SMOKE_TIMEOUT_MS });
  } finally {
    await context.close();
  }
}

async function globalSetup() {
  if (process.env.E2E_TESTS_ENABLED !== "1") return;

  const baseURL =
    process.env.PLAYWRIGHT_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const browser = await chromium.launch();
  try {
    for (const { role, emailEnvVar, next } of PREFLIGHT_ROLES) {
      const { email, password } = E2E_ACCOUNTS[role];
      try {
        await smokeSignIn(browser, baseURL, next, email, password);
      } catch (error) {
        const usedDefaultAccount = !process.env[emailEnvVar]?.trim();
        const lines = [
          `E2E preflight failed: could not sign in as the ${role} E2E account.`,
          `Tried "${email}" against ${baseURL}.`,
        ];
        if (usedDefaultAccount) {
          lines.push(
            `(${emailEnvVar} is unset/blank, so the built-in default account name was used.)`,
          );
        }
        lines.push(
          "",
          "E2E_TESTS_ENABLED=1 makes the portal suite sign in as seeded accounts, but the",
          `${role} sign-in never completed. The accounts are almost certainly not seeded in the`,
          "target Supabase project, or the E2E_* credential secrets are missing/wrong. Without",
          "them every portal spec times out on waitForURL and the job hangs for hours.",
          "",
          "Fix one of:",
          "  • Seed the accounts (`npm run test:seed`) and set the E2E_* repo secrets to match, or",
          "  • Unset E2E_TESTS_ENABLED so the portal specs skip instead of timing out.",
          "See tests/README.md.",
          "",
          `Underlying error: ${(error as Error).message.split("\n")[0]}`,
        );
        throw new Error(lines.join("\n"));
      }
    }
  } finally {
    await browser.close();
  }
}

export default globalSetup;
