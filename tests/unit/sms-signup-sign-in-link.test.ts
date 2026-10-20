// The one-tap sign-in link: token_hash (never a PKCE code), minted for the VERIFIED owner of the phone only, capped per phone.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const m = vi.hoisted(() => ({ owners: vi.fn(), rate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/phone-auth.server", () => ({ phoneOwners: m.owners }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: m.rate }));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://proplane.ai" }));

import { mintPhoneSignInLink } from "@/lib/one-number/signup/sign-in-link.server";

const PHONE = "+12065550142";
function db(over: { email?: string | null; token?: string | null } = {}) {
  const generateLink = vi.fn(async () => ({ data: over.token === null ? { properties: {} } : { properties: { hashed_token: over.token ?? "HASHED" } }, error: null }));
  const getUserById = vi.fn(async () => ({ data: { user: { email: over.email === undefined ? "abc@phone.proplane.invalid" : over.email } }, error: null }));
  return { db: { auth: { admin: { generateLink, getUserById } } } as unknown as SupabaseClient, generateLink };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.owners.mockResolvedValue(["u1"]);
  m.rate.mockResolvedValue({ ok: true });
});

describe("mintPhoneSignInLink", () => {
  it("is a token_hash confirm link (never a PKCE code) built from Supabase's hashed token", async () => {
    const { db: d, generateLink } = db();
    const url = await mintPhoneSignInLink(d, { phoneE164: PHONE, userId: "u1" });
    expect(url).toBe("https://proplane.ai/auth/confirm?token_hash=HASHED&type=magiclink");
    expect(url).not.toMatch(/[?&]code=/);
    expect(generateLink).toHaveBeenCalledWith({ type: "magiclink", email: "abc@phone.proplane.invalid" });
  });

  it("is bound to the phone: only the account that VERIFIABLY owns it gets a link", async () => {
    const { db: d, generateLink } = db();
    m.owners.mockResolvedValue(["someone-else"]);
    expect(await mintPhoneSignInLink(d, { phoneE164: PHONE, userId: "u1" })).toBeNull();
    m.owners.mockResolvedValue(["u1", "u2"]);
    expect(await mintPhoneSignInLink(d, { phoneE164: PHONE, userId: "u1" })).toBeNull();
    m.owners.mockResolvedValue([]);
    expect(await mintPhoneSignInLink(d, { phoneE164: PHONE, userId: "u1" })).toBeNull();
    expect(generateLink).not.toHaveBeenCalled();
  });

  it("is capped per phone per hour and the limiter key holds only a hash of the phone", async () => {
    const { db: d, generateLink } = db();
    m.rate.mockResolvedValue({ ok: false });
    expect(await mintPhoneSignInLink(d, { phoneE164: PHONE, userId: "u1" })).toBeNull();
    expect(generateLink).not.toHaveBeenCalled();
    const [key, limit, windowMs] = m.rate.mock.calls[0]!;
    expect(key).toMatch(/^sms-signin-link:[0-9a-f]{32}$/);
    expect(key).not.toContain("2065550142");
    expect([limit, windowMs]).toEqual([5, 3_600_000]);
  });

  it("returns null (never a half link) when Supabase gives no token or the owner check fails", async () => {
    expect(await mintPhoneSignInLink(db({ token: null }).db, { phoneE164: PHONE, userId: "u1" })).toBeNull();
    m.owners.mockRejectedValue(new Error("rpc down"));
    expect(await mintPhoneSignInLink(db().db, { phoneE164: PHONE, userId: "u1" })).toBeNull();
  });

  it("the stored link is only Supabase's token hash: this module persists nothing of its own", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/one-number/signup/sign-in-link.server.ts", "utf8");
    expect(src).not.toMatch(/\.from\(/);
  });
});
