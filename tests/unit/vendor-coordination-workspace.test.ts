import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/vendor-dispatch-settings", () => ({ loadVendorDispatchSettings: async () => ({ agentMessagingEnabled: true }) }));
import { resolveDirectoryVendorInbound } from "@/lib/vendor-coordination-identity.server";

function database(works: Record<string, unknown>[], properties: Record<string, unknown>[], propertyError = false) {
  const upserts: Record<string, unknown>[] = [];
  const records: Record<string, Record<string, unknown>[]> = {
    manager_vendor_records: [{ id: "directory", manager_user_id: "manager", vendor_user_id: "vendor", row_data: { phone: "+12065550100" } }],
    profiles: [{ id: "vendor", phone: "+12065550100", phone_verified_at: "2026-11-01" }],
    vendor_coordination_phone_bindings: [], portal_work_order_records: works,
    work_order_vendor_offers: [], manager_property_records: properties, agent_sessions: [],
  };
  const db = { from(table: string) {
    let rows = [...(records[table] ?? [])];
    const result = () => ({ data: rows, error: table === "manager_property_records" && propertyError ? { message: "unavailable" } : null });
    const q = { select: () => q,
      eq: (key: string, value: unknown) => { rows = rows.filter((r) => r[key] === value); return q; },
      in: (key: string, values: unknown[]) => { rows = rows.filter((r) => values.includes(r[key])); return q; },
      is: () => q,
      maybeSingle: async () => ({ ...result(), data: rows[0] ?? null }),
      single: async () => ({ ...result(), data: rows[0] ?? null }),
      upsert: (row: Record<string, unknown>) => { if (table === "agent_sessions") upserts.push(row); rows = [{ id: "session", ...row }]; return q; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return q;
  } };
  return { db, upserts };
}
const work = (id: string, property: string, assigned?: string) => ({ id, manager_user_id: "manager", property_id: property, assigned_property_id: assigned, row_data: { vendorId: "directory", bucket: "open", reference: id, title: `Private ${id}` } });
const properties = [{ id: "house-a", manager_user_id: "manager", workspace_id: "workspace-a" }, { id: "house-b", manager_user_id: "manager", workspace_id: "workspace-b" }];

describe("directory vendor recognition on workspace lines", () => {
  it("chooses only the service belonging to the texted line", async () => {
    const { db, upserts } = database([work("service-a", "house-a"), work("service-b", "house-b")], properties);
    const result = await resolveDirectoryVendorInbound(db as never, "manager", "+12065550100", "hello", "workspace-a");
    expect(result.kind).toBe("session"); expect(upserts[0]).toMatchObject({ work_order_id: "service-a" });
  });
  it("does not disclose another workspace's service or create its session", async () => {
    const { db, upserts } = database([work("service-b", "house-b")], properties);
    const result = await resolveDirectoryVendorInbound(db as never, "manager", "+12065550100", "hello", "workspace-a");
    expect(result.kind).toBe("blocked"); expect(JSON.stringify(result)).not.toContain("Private service-b"); expect(upserts).toEqual([]);
  });
  it("uses assigned house before the original property and fails closed for an unknown house", async () => {
    const { db, upserts } = database([work("reassigned", "house-a", "house-b"), work("unknown", "missing")], properties);
    expect((await resolveDirectoryVendorInbound(db as never, "manager", "+12065550100", "hello", "workspace-a")).kind).toBe("blocked"); expect(upserts).toEqual([]);
  });
  it("refuses a failed house lookup", async () => {
    const { db, upserts } = database([work("service-a", "house-a")], properties, true);
    await expect(resolveDirectoryVendorInbound(db as never, "manager", "+12065550100", "hello", "workspace-a")).rejects.toThrow("workspace unavailable"); expect(upserts).toEqual([]);
  });
  it("preserves unscoped legacy recognition when no workspace was supplied", async () => {
    const { db, upserts } = database([work("legacy", "missing")], []);
    expect((await resolveDirectoryVendorInbound(db as never, "manager", "+12065550100", "hello")).kind).toBe("session"); expect(upserts[0]).toMatchObject({ work_order_id: "legacy" });
  });
});
