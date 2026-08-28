import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { assertNonProdDatabase, getAdminRegisterKey, getPaymentWaiverCode, paymentWaiverCodeMatches } from "@/lib/server-env";
import { isValidAdminRegisterKey } from "@/lib/auth/admin-register-key";

describe("server-env and admin-register-key", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: "test", VERCEL_ENV: undefined };
    delete process.env.AXIS_ADMIN_REGISTER_KEY;
    delete process.env.AXIS_PAYMENT_WAIVER_CODE;
    delete process.env.AXIS_PROD_SUPABASE_REF;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses dev defaults for admin and waiver keys", () => {
    expect(getAdminRegisterKey()).toBe("prakrit-admin-register");
    expect(getPaymentWaiverCode()).toBe("FREE100");
    expect(paymentWaiverCodeMatches("free 100")).toBe(true);
    expect(isValidAdminRegisterKey("prakrit-admin-register")).toBe(true);
    expect(isValidAdminRegisterKey("wrong")).toBe(false);
  });

  it("offers NO waiver in production when env is unset", () => {
    // This test previously asserted the opposite — that FREE100 stayed live in production. That
    // is a paid-tier bypass anyone could use: the code sits in a public repo and the comparison
    // ignores case and punctuation. The built-in is a development convenience; production must
    // require an explicitly configured code, matching `getAdminRegisterKey` beside it.
    // Fuller coverage in `payment-waiver-code-production.test.ts`.
    process.env.VERCEL_ENV = "production";
    expect(getPaymentWaiverCode()).toBeNull();
    expect(paymentWaiverCodeMatches("FREE100")).toBe(false);
  });

  it("respects explicit env overrides", () => {
    process.env.AXIS_PAYMENT_WAIVER_CODE = "CUSTOM100";
    expect(getPaymentWaiverCode()).toBe("CUSTOM100");
  });
});

describe("assertNonProdDatabase", () => {
  const originalEnv = { ...process.env };
  const PROD_REF = "qahnczmilgptcedaqype";
  const DEV_REF = "emstjswhotsnyksqhqyf";

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: "test", VERCEL_ENV: undefined };
    delete process.env.AXIS_PROD_SUPABASE_REF;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when a non-prod runtime targets the production project", () => {
    process.env.AXIS_PROD_SUPABASE_REF = PROD_REF;
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${PROD_REF}.supabase.co`;
    expect(() => assertNonProdDatabase()).toThrow(/production/i);
  });

  it("does not throw when pointed at the dev/test project", () => {
    process.env.AXIS_PROD_SUPABASE_REF = PROD_REF;
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DEV_REF}.supabase.co`;
    expect(() => assertNonProdDatabase()).not.toThrow();
  });

  it("is a no-op when AXIS_PROD_SUPABASE_REF is unset", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${PROD_REF}.supabase.co`;
    expect(() => assertNonProdDatabase()).not.toThrow();
  });

  it("allows the production runtime to use the production project", () => {
    process.env.VERCEL_ENV = "production";
    process.env.AXIS_PROD_SUPABASE_REF = PROD_REF;
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${PROD_REF}.supabase.co`;
    expect(() => assertNonProdDatabase()).not.toThrow();
  });
});
