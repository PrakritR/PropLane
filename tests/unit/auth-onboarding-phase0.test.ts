import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("auth login redirect", () => {
  it("redirects legacy /auth/login to /auth/sign-in", () => {
    const config = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
    expect(config).toMatch(/source:\s*"\/auth\/login"/);
    expect(config).toMatch(/destination:\s*"\/auth\/sign-in"/);
  });
});

describe("get-started session gate", () => {
  const page = readFileSync(path.join(process.cwd(), "src/app/auth/get-started/page.tsx"), "utf8");

  it("sends unauthenticated users to sign-in instead of spinning forever", () => {
    expect(page).toMatch(/getSession\(\)/);
    expect(page).toMatch(/\/auth\/sign-in\?next=%2Fauth%2Fget-started/);
  });
});

describe("implicit auth hash recovery", () => {
  const mod = readFileSync(path.join(process.cwd(), "src/lib/auth/recover-implicit-auth-hash.ts"), "utf8");

  it("exports recoverImplicitAuthHash", () => {
    expect(mod).toMatch(/export async function recoverImplicitAuthHash/);
    expect(mod).toMatch(/setSession/);
  });
});

describe("manager partner-pricing create-account routing", () => {
  const router = readFileSync(
    path.join(process.cwd(), "src/app/auth/create-account/create-account-router.tsx"),
    "utf8",
  );
  const gateway = readFileSync(
    path.join(process.cwd(), "src/app/auth/create-account/create-account-role-gateway.tsx"),
    "utf8",
  );

  it("delegates role-based signup to CreateAccountRoleGateway", () => {
    expect(router).toMatch(/CreateAccountRoleGateway/);
  });

  it("uses ManagerTrialSignupForm for every role=manager create-account link", () => {
    expect(gateway).toMatch(/ManagerTrialSignupForm/);
    expect(gateway).toMatch(/role === "manager"/);
  });
});

describe("signup sign-in retry", () => {
  const raw = readFileSync(path.join(process.cwd(), "src/components/auth/portal-auth-form.tsx"), "utf8");
  // The scan is on CODE: the file's own comment names the deleted call to record that it is gone.
  const form = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

  it("has no password sign-in to retry — the hub signs in by emailed link", () => {
    // `signInAfterSignup` existed because the hub created an account and then had to race GoTrue
    // to sign in with the password it had just set. Nothing sets a password before the mailbox is
    // proven any more: the emailed `token_hash` link IS the sign-in, so the retry loop and the
    // password form it served are gone.
    expect(form).not.toMatch(/signInAfterSignup/);
    expect(form).not.toMatch(/signInWithPassword/);
    expect(form).toContain("<EmailFirstSignup");
  });
});
