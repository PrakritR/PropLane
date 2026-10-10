import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { table: string; filters: Record<string, unknown> };

const h = vi.hoisted(() => ({
  user: null as null | { userId: string },
  workspaces: [] as { id: string; name: string; ownerUserId: string; owned: boolean; isDefault: boolean; propertyIds: string[] }[],
  tables: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as Call[],
  /** Houses the viewer holds each module on, as an accepted co-manager. */
  grants: {} as Record<string, string[]>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: async () => (h.user ? { db: {}, userId: h.user.userId } : null),
}));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: async () => h.workspaces }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedPropertyIdsForModule: async (_db: unknown, _userId: string, module: string) => new Set(h.grants[module] ?? []),
}));
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
      const read = () => {
        h.calls.push({ table, filters });
        const propertyIds = (filters.property_id as string[] | undefined) ?? [];
        return (h.tables[table] ?? []).filter(
          (r) => propertyIds.includes(String(r.property_id)) && (!filters.source_channel || r.source_channel === filters.source_channel),
        );
      };
      // The reads are PAGED (ordered by primary key), so the newest leads are the
      // newest of every tagged row rather than of an arbitrary first page.
      q.range = (from: number) => Promise.resolve({ data: from === 0 ? read() : [], error: null });
      q.then = (resolve: (v: unknown) => void) => {
        resolve({ data: read(), error: null });
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
    h.grants = {};
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

  it("a co-manager needs the applications or residents grant, not just workspace membership", async () => {
    // `workspace.propertyIds` holds a house as soon as ANY module is granted on it,
    // so it is membership, not a grant — and a lead carries an applicant's name and
    // email. Calendar-only access must read nothing.
    const shared = { ...workspace("w1", "owner-9", ["p1", "p2"]), owned: false, isDefault: false };
    // The viewer's own (empty) workspace plus the shared one they were invited into.
    h.workspaces = [workspace("w-own", "u1", []), shared];
    const calendarOnly = await get("channel=craigslist&workspaceId=w1");
    expect(((await calendarOnly.json()) as { leads: unknown[] }).leads).toEqual([]);
    expect(h.calls).toHaveLength(0);

    h.grants = { applications: ["p1"] };
    const granted = await get("channel=craigslist&workspaceId=w1");
    const body = (await granted.json()) as { leads: { id: string }[] };
    expect(body.leads.map((l) => l.id)).toEqual(["t1"]);
    // p2 carries no grant, so its application never loads.
    expect(h.calls.flatMap((c) => (c.filters.property_id as string[]) ?? [])).not.toContain("p2");

    h.calls = [];
    h.grants = { residents: ["p2"] };
    const viaResidents = await get("channel=craigslist&workspaceId=w1");
    expect(((await viaResidents.json()) as { leads: { id: string }[] }).leads.map((l) => l.id)).toEqual(["AXIS-1"]);
  });

  it("an empty workspace reads nothing", async () => {
    h.workspaces = [workspace("w1", "u1", [])];
    const res = await get("channel=craigslist");
    expect(((await res.json()) as { leads: unknown[] }).leads).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });
});
