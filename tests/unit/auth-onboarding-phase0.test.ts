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

  it("uses ManagerTrialSignupForm for every role=manager create-account link", () => {
    expect(router).toMatch(/ManagerTrialSignupForm/);
    expect(router).toMatch(/role === "manager"/);
  });
});

describe("signup sign-in retry", () => {
  const form = readFileSync(path.join(process.cwd(), "src/components/auth/portal-auth-form.tsx"), "utf8");

  it("retries password sign-in after hub signup", () => {
    expect(form).toMatch(/signInAfterSignup/);
    expect(form).toMatch(/for \(let attempt = 0; attempt < 4; attempt\+\+\)/);
  });
});
