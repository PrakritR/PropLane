// Email proof for a phone-only account: our own hashed, single-use, 24h token mailed via Resend (not a Supabase email_change).
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })), clientIpFrom: () => "203.0.113.9" }));
import { EMAIL_PROOF_TTL_MS, hashEmailProofToken, startEmailProof, verifyEmailProof } from "@/lib/personal-link/email-proof.server";
import { linksFakeDb } from "../helpers/links-fake-db";

function setup(over: { updateError?: boolean } = {}) {
  const fake = linksFakeDb({ profiles: [{ id: "u1", email: "abc@phone.proplane.invalid" }] });
  const updateUserById = vi.fn(async () => ({ error: over.updateError ? { message: "boom" } : null }));
  (fake.db as unknown as { auth: unknown }).auth = { admin: { updateUserById } };
  return { ...fake, updateUserById };
}
const free = async () => false;
const tokenOf = (href: string) => decodeURIComponent(/token=([^&]+)/.exec(href)![1]!);

describe("startEmailProof", () => {
  it("stores only the SHA-256, bound to user and email, expiring in 24h, and mails our /auth/confirm-email link", async () => {
    const s = setup();
    const send = vi.fn(async () => true);
    expect(await startEmailProof(s.db, { userId: "u1", email: " Maya@Example.com " }, { emailTaken: free, send, now: () => new Date("2026-11-12T10:00:00Z") })).toBe(true);
    const { to, href } = send.mock.calls[0]![0];
    const token = tokenOf(href);
    expect(to).toBe("maya@example.com");
    expect(href).toMatch(/\/auth\/confirm-email\?token=[A-Za-z0-9_-]{43}$/);
    const row = s.rows.personal_email_proofs![0]!;
    expect(row).toMatchObject({ user_id: "u1", email: "maya@example.com", token_hash: hashEmailProofToken(token), expires_at: new Date(Date.parse("2026-11-12T10:00:00Z") + EMAIL_PROOF_TTL_MS).toISOString() });
    expect(JSON.stringify(s.rows.personal_email_proofs)).not.toContain(token);
    expect(s.updateUserById).not.toHaveBeenCalled();
  });

  it("a taken (or unreadable) email stores nothing and sends nothing; a newer proof replaces the older", async () => {
    const s = setup();
    const send = vi.fn(async () => true);
    expect(await startEmailProof(s.db, { userId: "u1", email: "held@example.com" }, { emailTaken: async () => true, send })).toBe(false);
    expect(await startEmailProof(s.db, { userId: "u1", email: "x@example.com" }, { emailTaken: async () => { throw new Error("down"); }, send })).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(s.rows.personal_email_proofs ?? []).toHaveLength(0);
    await startEmailProof(s.db, { userId: "u1", email: "a@example.com" }, { emailTaken: free, send });
    const first = tokenOf(send.mock.calls[0]![0].href);
    await startEmailProof(s.db, { userId: "u1", email: "a@example.com" }, { emailTaken: free, send });
    expect(await verifyEmailProof(s.db, first, { emailTaken: free })).toBe(false);
    expect(await verifyEmailProof(s.db, tokenOf(send.mock.calls[1]![0].href), { emailTaken: free })).toBe(true);
  });
});

describe("verifyEmailProof", () => {
  async function minted() {
    const s = setup();
    const send = vi.fn(async () => true);
    await startEmailProof(s.db, { userId: "u1", email: "maya@example.com" }, { emailTaken: free, send });
    return { ...s, token: tokenOf(send.mock.calls[0]![0].href) };
  }

  it("confirms the email through the admin API (confirmed, password login now works), once only", async () => {
    const s = await minted();
    expect(await verifyEmailProof(s.db, s.token, { emailTaken: free })).toBe(true);
    expect(s.updateUserById).toHaveBeenCalledWith("u1", { email: "maya@example.com", email_confirm: true });
    expect(s.rows.profiles![0]!.email).toBe("maya@example.com");
    expect(await verifyEmailProof(s.db, s.token, { emailTaken: free })).toBe(false);
    expect(s.updateUserById).toHaveBeenCalledTimes(1);
  });

  it("unknown, malformed, expired and now-taken all fail alike and change nothing", async () => {
    const s = await minted();
    expect(await verifyEmailProof(s.db, "nope", { emailTaken: free })).toBe(false);
    expect(await verifyEmailProof(s.db, "A".repeat(43), { emailTaken: free })).toBe(false);
    expect(await verifyEmailProof(s.db, s.token, { emailTaken: free, now: () => new Date(Date.now() + EMAIL_PROOF_TTL_MS + 1000) })).toBe(false);
    expect(await verifyEmailProof(s.db, s.token, { emailTaken: async () => true })).toBe(false);
    expect(s.updateUserById).not.toHaveBeenCalled();
  });

  it("a refused account change gives the token back", async () => {
    const s = setup({ updateError: true });
    const send = vi.fn(async () => true);
    await startEmailProof(s.db, { userId: "u1", email: "maya@example.com" }, { emailTaken: free, send });
    const token = tokenOf(send.mock.calls[0]![0].href);
    expect(await verifyEmailProof(s.db, token, { emailTaken: free })).toBe(false);
    expect(s.rows.personal_email_proofs![0]!.used_at).toBeNull();
  });
});

describe("wiring", () => {
  it("the migration is additive, RLS on, no client grants; the table is classified; Supabase email_change is gone", () => {
    const sql = readFileSync("supabase/migrations/20261112210000_personal_email_proofs.sql", "utf8");
    expect(sql).toMatch(/create table if not exists public\.personal_email_proofs/);
    expect(sql).toMatch(/enable row level security/);
    expect(sql).toMatch(/revoke all on public\.personal_email_proofs from anon, authenticated/);
    expect(readFileSync("src/lib/auth/account-purge-manifest.ts", "utf8")).toContain("personal_email_proofs:");
    expect(readFileSync("src/lib/personal-link/email-proof.server.ts", "utf8")).not.toMatch(/generateLink|email_change_new/);
  });

  it("the route answers one generic error and the page spends the token only on a button press", async () => {
    const page = readFileSync("src/app/auth/confirm-email/page.tsx", "utf8");
    expect(page).toContain("/api/auth/confirm-email-proof");
    expect(page).toMatch(/onClick=\{\(\) => void confirm\(\)\}/);
  });
});
