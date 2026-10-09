import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { table: string; filters: Record<string, unknown> };

const h = vi.hoisted(() => ({
  user: null as null | { userId: string },
  workspaces: [] as { id: string; name: string; ownerUserId: string; owned: boolean; isDefault: boolean; propertyIds: string[] }[],
  tables: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as Call[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: async () => (h.user ? { db: {}, userId: h.user.userId } : null),
}));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: async () => h.workspaces }));
vi.mock("@/lib/auth/view-as-guard", () => ({ isViewAsSessionOpen: async () => false }));
vi.mock("@/lib/tour-inquiry-create.server", () => ({ INQUIRY_EVENT_RECORD_TYPE: "partner_inquiry_request" }));
vi.mock("@/lib/security/applicant-identity", () => ({ openApplicantRow: (raw: unknown) => raw }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const q: Record<string, unknown> = {};
      for (const m of ["select", "order", "limit"]) q[m] = () => q;
      q.eq = (k: string, v: unknown) => ((filters[k] = v), q);
      q.in = (k: string, v: unknown) => ((filters[k] = v), q);
      q.then = (resolve: (v: unknown) => void) => {
        h.calls.push({ table, filters });
        const propertyIds = (filters.property_id as string[] | undefined) ?? [];
        const rows = (h.tables[table] ?? []).filter(
          (r) => propertyIds.includes(String(r.property_id)) && (!filters.source_channel || r.source_channel === filters.source_channel),
        );
        resolve({ data: rows, error: null });
      };
      return q;
    },
  }),
}));

import { GET } from "@/app/api/manager/listing-channels/leads/route";

const get = (qs: string) => GET(new Request(`https://proplane.ai/api/manager/listing-channels/leads?${qs}`));
const workspace = (id: string, owner: string, propertyIds: string[]) => ({ id, name: id, ownerUserId: owner, owned: true, isDefault: true, propertyIds });

describe("GET /api/manager/listing-channels/leads", () => {
  beforeEach(() => {
    h.user = { userId: "u1" };
    h.workspaces = [workspace("w1", "u1", ["p1", "p2"])];
    h.calls = [];
    h.tables = {
      portal_schedule_records: [
        { id: "partner_inquiry_request_t1_0", property_id: "p1", source_channel: "craigslist", starts_at: "2026-10-10T22:00:00Z", row_data: { payload: { id: "t1", name: "Maya Chen", email: "m@x.com" } } },
        { id: "partner_inquiry_request_t1_1", property_id: "p1", source_channel: "craigslist", starts_at: "2026-10-11T22:00:00Z", row_data: { payload: { id: "t1", name: "Maya Chen" } } },
        { id: "partner_inquiry_request_t9_0", property_id: "p1", source_channel: "reddit", starts_at: "2026-10-12T22:00:00Z", row_data: { payload: { id: "t9", name: "Wrong Site" } } },
        { id: "partner_inquiry_request_t8_0", property_id: "other-ws", source_channel: "craigslist", starts_at: "2026-10-12T22:00:00Z", row_data: { payload: { id: "t8", name: "Other Workspace" } } },
      ],
      manager_application_records: [
        { id: "AXIS-1", property_id: "p2", source_channel: "craigslist", updated_at: "2026-10-09T10:00:00Z", row_data: { name: "Diego Morales", bucket: "approved" } },
      ],
    };
  });

  it("is 401 when nobody is signed in", async () => {
    h.user = null;
    expect((await get("channel=craigslist")).status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses an unknown site", async () => {
    expect((await get("channel=not-a-site")).status).toBe(400);
    expect((await get("")).status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("returns this site's tours (one per inquiry) and applications for the workspace's own listings, newest first", async () => {
    const res = await get("channel=craigslist&workspaceId=w1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { leads: { kind: string; id: string; name: string; bucket: string; propertyId: string }[] };
    expect(body.leads.map((l) => [l.kind, l.id, l.name])).toEqual([
      ["tour", "t1", "Maya Chen"],
      ["application", "AXIS-1", "Diego Morales"],
    ]);
    expect(body.leads.find((l) => l.kind === "application")!.bucket).toBe("approved");
    expect(body.leads.some((l) => l.id === "t9" || l.id === "t8")).toBe(false);
    expect(JSON.stringify(body)).not.toContain("m@x.com");
  });

  it("a workspaceId the viewer is not in never widens the read: it falls back to their own workspace's listings", async () => {
    h.workspaces = [workspace("w1", "u1", ["p1"]), ];
    await get("channel=craigslist&workspaceId=someone-elses-workspace");
    const scoped = h.calls.flatMap((c) => (c.filters.property_id as string[]) ?? []);
    expect(new Set(scoped)).toEqual(new Set(["p1"]));
  });

  it("ignores property ids in the request: the listings come from the session's workspace", async () => {
    await get("channel=craigslist&propertyIds=other-ws&propertyId=other-ws");
    const scoped = h.calls.flatMap((c) => (c.filters.property_id as string[]) ?? []);
    expect(scoped).not.toContain("other-ws");
  });

  it("an empty workspace reads nothing", async () => {
    h.workspaces = [workspace("w1", "u1", [])];
    const res = await get("channel=craigslist");
    expect(((await res.json()) as { leads: unknown[] }).leads).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });
});
