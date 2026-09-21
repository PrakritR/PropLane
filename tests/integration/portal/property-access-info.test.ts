import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: vi.fn().mockResolvedValue({ kind: "normal" }),
}));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { GET, PATCH } from "@/app/api/portal/property-access-info/route";

function mockAuth(userId: string | null, role = "manager") {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: userId ? { id: userId, user_metadata: {} } : null } }),
    },
  } as never);
  return role;
}

function mockDb(opts: {
  role?: string;
  propertyOwners?: Record<string, string>;
  accessRows?: Map<string, { access_info: unknown }>;
}) {
  const accessRows = opts.accessRows ?? new Map<string, { access_info: unknown }>();
  const upserts: Array<Record<string, unknown>> = [];

  const client = {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: { role: opts.role ?? "manager" } }),
        };
      }
      if (table === "profile_roles") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({ data: opts.role === "manager" ? [{ role: "manager" }] : [] }),
        };
      }
      if (table === "manager_property_records") {
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => {
                const owner = opts.propertyOwners?.[id];
                return { data: owner ? { manager_user_id: owner } : null, error: null };
              },
            }),
          }),
        };
      }
      if (table === "manager_property_access") {
        const filters: Record<string, string> = {};
        return {
          select: vi.fn().mockImplementation(() => ({
            eq: function eq(col: string, val: string) {
              filters[col] = val;
              return {
                eq,
                maybeSingle: async () => ({
                  data: accessRows.get(`${filters.property_id}:${filters.manager_user_id}`) ?? null,
                  error: null,
                }),
              };
            },
          })),
          upsert: async (row: Record<string, unknown>) => {
            upserts.push(row);
            accessRows.set(`${row.property_id}:${row.manager_user_id}`, { access_info: row.access_info });
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client: client as never, upserts, accessRows };
}

describe("/api/portal/property-access-info", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires authentication and a manager role", async () => {
    mockAuth(null);
    const { client } = mockDb({});
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client);
    expect((await parseJsonResponse(await GET(jsonRequest("http://t?propertyId=p1")))).status).toBe(401);

    mockAuth("res-1", "resident");
    const { client: c2 } = mockDb({ role: "resident" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(c2);
    expect((await parseJsonResponse(await GET(jsonRequest("http://t?propertyId=p1")))).status).toBe(401);
  });

  it("rejects writing access info for another manager's listed property", async () => {
    mockAuth("mgr-a");
    const { client, upserts } = mockDb({ propertyOwners: { "prop-b": "mgr-b" } });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client);

    const res = await PATCH(
      jsonRequest("http://t", { method: "PATCH", body: { propertyId: "prop-b", accessInfo: { gateCode: "1111" } } }),
    );
    expect((await parseJsonResponse(res)).status).toBe(403);
    expect(upserts).toHaveLength(0);
  });

  it("round-trips access info scoped per manager", async () => {
    mockAuth("mgr-a");
    const { client, upserts } = mockDb({ propertyOwners: { "prop-a": "mgr-a" } });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client);

    const save = await PATCH(
      jsonRequest("http://t", {
        method: "PATCH",
        body: { propertyId: "prop-a", accessInfo: { gateCode: " 4821 ", entryNotes: "side door" } },
      }),
    );
    const saved = await parseJsonResponse<{ accessInfo: { gateCode: string } }>(save);
    expect(saved.status).toBe(200);
    expect(saved.data.accessInfo.gateCode).toBe("4821");
    expect(upserts[0]).toMatchObject({ property_id: "prop-a", manager_user_id: "mgr-a" });

    const read = await GET(jsonRequest("http://t?propertyId=prop-a"));
    const got = await parseJsonResponse<{ accessInfo: { gateCode: string; entryNotes: string } }>(read);
    expect(got.status).toBe(200);
    expect(got.data.accessInfo).toMatchObject({ gateCode: "4821", entryNotes: "side door" });
  });

  it("allows unlisted/legacy property ids, isolated by manager", async () => {
    mockAuth("mgr-a");
    const { client, upserts } = mockDb({});
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client);

    const res = await PATCH(
      jsonRequest("http://t", { method: "PATCH", body: { propertyId: "legacy-1", accessInfo: { lockboxCode: "9" } } }),
    );
    expect((await parseJsonResponse(res)).status).toBe(200);
    expect(upserts[0]).toMatchObject({ property_id: "legacy-1", manager_user_id: "mgr-a" });
  });
});
