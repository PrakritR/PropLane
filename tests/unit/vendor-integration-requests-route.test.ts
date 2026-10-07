import { beforeEach, describe, expect, it, vi } from "vitest";

const VENDOR = "11111111-1111-4111-8111-111111111111";

const store = { rows: [] as Array<{ vendor_user_id: string; provider: string }>, error: null as { message: string } | null };

function fakeDb() {
  return {
    from: () => ({
      select: () => ({
        eq: async (_col: string, vendor: string) => ({
          data: store.error ? null : store.rows.filter((r) => r.vendor_user_id === vendor),
          error: store.error,
        }),
      }),
      upsert: async (row: { vendor_user_id: string; provider: string }) => {
        if (store.error) return { error: store.error };
        if (!store.rows.some((r) => r.vendor_user_id === row.vendor_user_id && r.provider === row.provider)) store.rows.push(row);
        return { error: null };
      },
    }),
  };
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => fakeDb() }));
const resolveVendor = vi.fn();
vi.mock("@/lib/auth/vendor-api-access", () => ({ resolveVendorPortalUserId: () => resolveVendor() }));

import { GET, POST } from "@/app/api/vendor/integration-requests/route";

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/vendor/integration-requests", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  store.rows = [];
  store.error = null;
  resolveVendor.mockReset();
  resolveVendor.mockResolvedValue({ ok: true, userId: VENDOR });
});

describe("/api/vendor/integration-requests", () => {
  it("401s a non-vendor", async () => {
    resolveVendor.mockResolvedValue({ ok: false, status: 401 });
    expect((await GET()).status).toBe(401);
    expect((await post({ provider: "jobber" })).status).toBe(401);
    expect(store.rows).toHaveLength(0);
  });

  it("records an allowlisted provider, idempotently, and lists it", async () => {
    expect((await post({ provider: "jobber" })).status).toBe(200);
    expect((await post({ provider: "jobber" })).status).toBe(200);
    expect((await post({ provider: "housecall_pro" })).status).toBe(200);
    expect(store.rows).toHaveLength(2);
    const body = (await (await GET()).json()) as { ok: boolean; requested: string[] };
    expect(body.requested.sort()).toEqual(["housecall_pro", "jobber"]);
  });

  it("400s anything outside the three providers and writes nothing", async () => {
    for (const bad of [{ provider: "quickbooks" }, { provider: "" }, { provider: 5 }, {}, null]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(store.rows).toHaveLength(0);
  });

  it("answers 503 with a clear error when the table is missing", async () => {
    store.error = { message: 'relation "vendor_integration_access_requests" does not exist' };
    const res = await post({ provider: "thumbtack" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("Could not send your request.");
    expect((await GET()).status).toBe(503);
  });
});
