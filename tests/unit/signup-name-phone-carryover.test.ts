import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/tour-resident-link.server", () => ({
  linkAllTourInquiriesForEmail: vi.fn(async () => undefined),
  reconcileProspectInboxThreadsForResident: vi.fn(async () => undefined),
}));
vi.mock("@/lib/auth/profile-role-row", () => ({ ensureProfileRoleRow: vi.fn(async () => undefined) }));

import { ensureSignedInResidentAccount } from "@/lib/auth/ensure-signed-in-resident.server";
import { readPhoneIdentity } from "@/lib/auth/phone-auth.server";
import { linkAllTourInquiriesForEmail, reconcileProspectInboxThreadsForResident } from "@/lib/tour-resident-link.server";

type Call = { table: string; op: string; payload?: unknown };

function db(profile: Record<string, unknown> | null) {
  const calls: Call[] = [];
  const client = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: table === "profiles" ? profile : null, error: null }),
          then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
        }),
      }),
      insert: (payload: unknown) => { calls.push({ table, op: "insert", payload }); return Promise.resolve({ error: null }); },
      update: (payload: unknown) => {
        calls.push({ table, op: "update", payload });
        const chain = { eq: () => chain, is: () => Promise.resolve({ error: null }), then: (r: (v: unknown) => void) => r({ error: null }) };
        return chain;
      },
    }),
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("the name and number typed at signup reach the profile when the resident role is provisioned", () => {
  const user = { id: "u1", email: "w@example.com", user_metadata: { full_name: "Wanda Webfix", phone: "(206) 555-0177" } };

  it("creates the profile with the typed name, then files the number unverified", async () => {
    const { client, calls } = db(null);
    const result = await ensureSignedInResidentAccount(client, user);
    expect(result.ok).toBe(true);
    expect(calls.find((c) => c.op === "insert")?.payload).toMatchObject({ id: "u1", full_name: "Wanda Webfix" });
    const phoneWrite = calls.find((c) => c.op === "update" && (c.payload as Record<string, unknown>).phone);
    expect(phoneWrite?.payload).toEqual({ phone: "+12065550177" });
    expect(JSON.stringify(calls)).not.toContain("phone_verified_at");
  });

  it("never overwrites a name or number the profile already holds", async () => {
    const { client, calls } = db({ role: "resident", email: "w@example.com", full_name: "Lena", phone: "+12065550143" });
    await ensureSignedInResidentAccount(client, user);
    expect(calls.filter((c) => c.op === "update")).toHaveLength(0);
  });
});

describe("resident historical email linking", () => {
  it.each([
    ["unconfirmed mailbox", { id: "u1", email: "w@example.com" }, "w@example.com"],
    ["different profile mailbox", { id: "u1", email: "w@example.com", email_confirmed_at: "confirmed" }, "other@example.com"],
    ["phone placeholder", { id: "u1", email: "123@phone.proplane.invalid", email_confirmed_at: "confirmed" }, "123@phone.proplane.invalid"],
  ])("does not backfill for %s", async (_label, user, email) => {
    vi.clearAllMocks();
    const { client } = db({ role: "resident", email });
    expect((await ensureSignedInResidentAccount(client, user)).ok).toBe(true);
    expect(linkAllTourInquiriesForEmail).not.toHaveBeenCalled();
    expect(reconcileProspectInboxThreadsForResident).not.toHaveBeenCalled();
  });

  it("backfills only the matching confirmed Auth mailbox", async () => {
    vi.clearAllMocks();
    const { client } = db({ role: "resident", email: "W@example.com" });
    await ensureSignedInResidentAccount(client, { id: "u1", email: "w@example.com", email_confirmed_at: "confirmed" });
    expect(linkAllTourInquiriesForEmail).toHaveBeenCalledWith(client, { userId: "u1", email: "w@example.com" });
    expect(reconcileProspectInboxThreadsForResident).toHaveBeenCalledWith(client, expect.objectContaining({ contactEmail: "w@example.com" }));
  });
});

describe("the verify screen is prefilled with the number typed at signup", () => {
  function identityDb(profile: Record<string, unknown> | null, metaPhone: string | undefined) {
    return {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }) }),
      auth: { admin: { getUserById: async () => ({ error: null, data: { user: { phone: null, user_metadata: metaPhone ? { phone: metaPhone } : {} } } }) } },
    } as unknown as SupabaseClient;
  }

  it("returns the typed number, unverified, when no profile row exists yet", async () => {
    await expect(readPhoneIdentity(identityDb(null, "+12065550177"), "u1")).resolves.toEqual({ phone: "+12065550177", verified: false });
  });

  it("keeps the profile's own number over the typed one", async () => {
    await expect(readPhoneIdentity(identityDb({ phone: "+12065550143", phone_verified_at: null }, "+12065550177"), "u1")).resolves.toEqual({ phone: "+12065550143", verified: false });
  });

  it("is null with nothing typed", async () => {
    await expect(readPhoneIdentity(identityDb(null, undefined), "u1")).resolves.toEqual({ phone: null, verified: false });
  });
});
