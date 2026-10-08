import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/vendor-own-record", () => ({ resolveOwnVendorRecord: vi.fn() }));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveOwnVendorRecord } from "@/lib/vendor-own-record";
import { GET, PATCH } from "@/app/api/vendor/profile/route";

const OWN = {
  id: "v-1",
  managerUserId: "mgr-a",
  row: {
    id: "v-1",
    managerUserId: "mgr-a",
    name: "Pipes R Us",
    trade: "Plumbing",
    phone: "(206) 555-1234",
    email: "pipes@example.com",
    notes: "",
    active: true,
  },
};

function mockVendorAuth() {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "vendor-user-1" } } }) },
  } as never);
}

function mockDb(profileRow: Record<string, unknown> = {}) {
  const rowUpdates: Array<Record<string, unknown>> = [];
  const profileUpdates: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: { role: "vendor", ...profileRow } }),
          update: (patch: Record<string, unknown>) => ({
            eq: async () => {
              profileUpdates.push(patch);
              return { error: null };
            },
          }),
        };
      }
      if (table === "manager_vendor_records") {
        return {
          update: (patch: Record<string, unknown>) => ({
            eq: async () => {
              rowUpdates.push(patch);
              return { error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client: client as never, rowUpdates, profileUpdates };
}

describe("/api/vendor/profile contact fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveOwnVendorRecord).mockResolvedValue(OWN as never);
  });

  it("GET returns canonical contact fields from profiles", async () => {
    mockVendorAuth();
    const { client } = mockDb({
      phone: "+12065551234",
      preferred_language: "es",
      sms_consent_at: "2026-07-01T00:00:00Z",
      phone_verified_at: "2026-07-02T00:00:00Z",
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client);

    const { status, data } = await parseJsonResponse<{
      contact: { phone: string; preferredLanguage: string; smsConsent: boolean; phoneVerifiedAt: string | null };
    }>(
      await GET(),
    );
    expect(status).toBe(200);
    expect(data.contact).toEqual({
      phone: "+12065551234",
      preferredLanguage: "es",
      smsConsent: true,
      phoneVerifiedAt: "2026-07-02T00:00:00Z",
    });
  });

  it("PATCH rejects an unnormalizable phone with 400 and writes nothing", async () => {
    mockVendorAuth();
    const { client, rowUpdates, profileUpdates } = mockDb();
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client);

    const res = await PATCH(jsonRequest("http://t", { method: "PATCH", body: { phone: "call me maybe" } }));
    expect((await parseJsonResponse(res)).status).toBe(400);
    expect(rowUpdates).toHaveLength(0);
    expect(profileUpdates).toHaveLength(0);
  });

  it("PATCH dual-writes: display copy on the directory row, E.164 + consent + language on profiles", async () => {
    mockVendorAuth();
    const { client, rowUpdates, profileUpdates } = mockDb();
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client);

    const res = await PATCH(
      jsonRequest("http://t", {
        method: "PATCH",
        body: { phone: "+44 20 7946 0958", preferredLanguage: "es", smsConsent: true },
      }),
    );
    expect((await parseJsonResponse(res)).status).toBe(200);

    const row = rowUpdates[0]!.row_data as { phone: string; preferredLanguage?: string };
    expect(row.phone).toBe("+44 20 7946 0958");
    expect(row.preferredLanguage).toBe("es");

    const profile = profileUpdates[0]!;
    expect(profile.phone).toBe("+442079460958");
    expect(profile.preferred_language).toBe("es");
    expect(typeof profile.sms_consent_at).toBe("string");
  });

  it("PATCH clears consent without touching other fields", async () => {
    mockVendorAuth();
    const { client, profileUpdates } = mockDb();
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client);

    const res = await PATCH(jsonRequest("http://t", { method: "PATCH", body: { smsConsent: false } }));
    expect((await parseJsonResponse(res)).status).toBe(200);
    expect(profileUpdates[0]).toEqual({ sms_consent_at: null });
  });
});
