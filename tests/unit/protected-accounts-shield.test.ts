import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Staging runs on a clone of the production database, so one account's real
 * residents are reachable from every non-production environment. The outbound
 * log already shows real late-fee notices landing on a resident's address, so
 * these cases pin the two properties that matter: production is untouched, and
 * everywhere else the send does not happen - including when the lookup that
 * decides who is protected fails.
 */
const PROTECTED_MANAGER = "c49d02b1-7e99-4484-9986-b3b4550c3519";
const RESIDENT_EMAIL = "real.resident@example.com";
const RESIDENT_PHONE = "+12065551234";

let rows: Record<string, unknown>[] = [];
let selectError: string | null = null;

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        in: () => ({
          limit: () =>
            Promise.resolve(
              selectError ? { data: null, error: { message: selectError } } : { data: rows, error: null },
            ),
        }),
      }),
    }),
  }),
}));

async function freshModule() {
  vi.resetModules();
  return import("@/lib/protected-accounts.server");
}

describe("protected account shield", () => {
  beforeEach(() => {
    rows = [{ manager_user_id: PROTECTED_MANAGER, resident_email: RESIDENT_EMAIL, row_data: { phone: RESIDENT_PHONE } }];
    selectError = null;
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://xwszcafaontidfgznlxd.supabase.co");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does nothing against dev/test, which has no real customer to protect", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://emstjswhotsnyksqhqyf.supabase.co");
    const { isShieldedRecipient } = await freshModule();
    expect(await isShieldedRecipient({ email: "ogambik2@gmail.com" })).toBe(false);
  });

  it("shields the named account owner and its co-manager", async () => {
    const { isShieldedRecipient } = await freshModule();
    expect(await isShieldedRecipient({ email: "ogambik2@gmail.com" })).toBe(true);
    expect(await isShieldedRecipient({ email: "prakritramachandran@gmail.com" })).toBe(true);
  });

  it("shields a resident of the account, who is never named in code", async () => {
    const { isShieldedRecipient } = await freshModule();
    expect(await isShieldedRecipient({ email: RESIDENT_EMAIL })).toBe(true);
    expect(await isShieldedRecipient({ phone: RESIDENT_PHONE })).toBe(true);
  });

  it("matches a resident regardless of address casing or phone formatting", async () => {
    const { isShieldedRecipient } = await freshModule();
    expect(await isShieldedRecipient({ email: RESIDENT_EMAIL.toUpperCase() })).toBe(true);
    expect(await isShieldedRecipient({ phone: "(206) 555-1234" })).toBe(true);
  });

  it("leaves every other recipient alone, so QA keeps working", async () => {
    const { isShieldedRecipient } = await freshModule();
    expect(await isShieldedRecipient({ email: "manager@test.proplane.local" })).toBe(false);
    expect(await isShieldedRecipient({ phone: "+12025550100" })).toBe(false);
  });

  it("does nothing in production, where these accounts are the real customers", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const { isShieldedRecipient } = await freshModule();
    expect(await isShieldedRecipient({ email: RESIDENT_EMAIL })).toBe(false);
    expect(await isShieldedRecipient({ email: "ogambik2@gmail.com" })).toBe(false);
  });

  it("fails closed: an unusable lookup shields everyone rather than nobody", async () => {
    selectError = "connection refused";
    const { isShieldedRecipient } = await freshModule();
    expect(await isShieldedRecipient({ email: "anyone@example.com" })).toBe(true);
  });
});

describe("outbound email transport shield", () => {
  beforeEach(() => {
    rows = [{ manager_user_id: PROTECTED_MANAGER, resident_email: RESIDENT_EMAIL }];
    selectError = null;
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://xwszcafaontidfgznlxd.supabase.co");
    delete (globalThis as { __axisProtectedAccountShieldInstalled?: boolean })
      .__axisProtectedAccountShieldInstalled;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function installed() {
    vi.resetModules();
    const upstream = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", upstream);
    const { installProtectedAccountFetchShield } = await import(
      "@/lib/protected-accounts-fetch-shield.server"
    );
    installProtectedAccountFetchShield();
    return upstream;
  }

  const post = (body: unknown) =>
    fetch("https://api.resend.com/emails", { method: "POST", body: JSON.stringify(body) });

  it("blocks a send to a protected resident without reaching Resend", async () => {
    const upstream = await installed();
    const res = await post({ from: "a@b.com", to: RESIDENT_EMAIL, subject: "Late fee" });
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("blocks when the address is wrapped in a display name", async () => {
    const upstream = await installed();
    const res = await post({ to: [`Real Resident <${RESIDENT_EMAIL}>`] });
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("blocks a batch where any one recipient is protected", async () => {
    const upstream = await installed();
    const res = await post([{ to: "someone@test.proplane.local" }, { to: RESIDENT_EMAIL }]);
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("catches a protected address hidden in cc or bcc", async () => {
    const upstream = await installed();
    const res = await post({ to: "ok@test.proplane.local", bcc: [RESIDENT_EMAIL] });
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("lets an ordinary QA send through untouched", async () => {
    const upstream = await installed();
    const res = await post({ to: "manager@test.proplane.local", subject: "Hello" });
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("never inspects or delays a non-Resend request", async () => {
    const upstream = await installed();
    await fetch("https://xwszcafaontidfgznlxd.supabase.co/rest/v1/whatever", {
      method: "POST",
      body: JSON.stringify({ to: RESIDENT_EMAIL }),
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
