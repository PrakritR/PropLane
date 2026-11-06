import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ rows: {} as Record<string, Record<string, unknown>[]>, download: vi.fn() }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedPropertyIdsForModule: async () => new Set() }));
vi.mock("@/lib/scope/settings-scope", () => ({ assertSettingsScopeOwned: async () => ({ ok: false }) }));
vi.mock("@/lib/reports/auth", () => ({ getReportsAuthContext: async () => ({ userId: "resident-new", email: "reused@example.test", db: {
  from(table: string) {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    const q = {
      select: () => q,
      eq: (key: string, value: unknown) => { filters.push(row => key === "row_data->>residentUserId" ? (row.row_data as Record<string, unknown>)?.residentUserId === value : row[key] === value); return q; },
      in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return q; },
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: (state.rows[table] ?? []).filter(row => filters.every(f => f(row))), error: null }).then(resolve),
    }; return q;
  }, storage: { from: () => ({ download: state.download }) },
} }) }));
import { GET } from "@/app/api/portal/lease-template/route";
const manager = "10000000-0000-4000-8000-000000000001";
const path = `${manager}/template.pdf`;
const url = `/api/portal/lease-template?path=${encodeURIComponent(path)}`;
const get = () => GET(new Request(`https://example.test${url}`));
beforeEach(() => { state.rows = {}; state.download.mockReset().mockResolvedValue({ data: new Blob(["pdf"]), error: null }); });
describe("resident lease template subject binding", () => {
  it("denies a lease linked to a different user despite the same email", async () => {
    state.rows.portal_lease_pipeline_records = [{ resident_user_id: "old", resident_email: "reused@example.test", manager_user_id: manager, row_data: { generatedHtml: url } }];
    expect((await get()).status).toBe(404);
    expect(state.download).not.toHaveBeenCalled();
  });
  it("allows the exact resident lease without email", async () => {
    state.rows.portal_lease_pipeline_records = [{ resident_user_id: "resident-new", manager_user_id: manager, row_data: { generatedHtml: url } }];
    expect((await get()).status).toBe(200);
  });
  it("requires an approved application linked to the same resident for the property", async () => {
    state.rows.manager_property_records = [{ id: "property", manager_user_id: manager, property_data: { listingSubmission: { leaseTemplateDocUrl: url } } }];
    state.rows.manager_application_records = [{ property_id: "property", manager_user_id: manager, resident_email: "reused@example.test", row_data: { bucket: "approved", residentUserId: "old" } }];
    expect((await get()).status).toBe(404);
    state.rows.manager_application_records[0].row_data = { bucket: "approved", residentUserId: "resident-new" };
    expect((await get()).status).toBe(200);
  });
});
