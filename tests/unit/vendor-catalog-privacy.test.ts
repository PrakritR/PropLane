import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { vendorCatalogProjection } from "@/lib/vendor-catalog-projection";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";

const mocks = vi.hoisted(() => ({ db: vi.fn(), scope: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "viewer" } } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.db }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedOwnerScopeForModule: mocks.scope }));
import { GET } from "@/app/api/portal-vendors/route";

const row = { id: "vendor", managerUserId: "owner", name: "Sam", trade: "Plumbing", phone: "123", email: "sam@example.test", active: true, sharedWithManagers: true,
  notes: "secret", preferredName: "private name", messaging: { instructions: "secret" }, checkIns: [{ reply: "secret" }], propertyIds: ["private-house"], futureSecret: "secret" } as unknown as ManagerVendorRow;

beforeEach(() => {
  mocks.scope.mockResolvedValue({ ownerIds: new Set<string>() });
  mocks.db.mockReturnValue({ from(table: string) {
    let shared = false;
    const query = {
      select: () => query, order: () => query, limit: () => query, ilike: () => query,
      eq: () => query, neq: () => { shared = true; return query; },
      maybeSingle: async () => ({ data: { role: "manager" } }),
      then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: table === "manager_vendor_records" && shared ? [{ row_data: row, manager_user_id: "owner" }] : [], error: null }).then(resolve); },
    };
    return query;
  } });
});

describe("shared vendor privacy", () => {
  it("uses an explicit public allowlist", () => {
    expect(vendorCatalogProjection(row, "stored-owner")).toEqual({ id: "vendor", managerUserId: "stored-owner", name: "Sam", trade: "Plumbing", trades: undefined, phone: "123", email: "sam@example.test", notes: "", active: true, sharedWithManagers: true });
  });
  it.each(["", "?catalog=1"])("projects unrelated shared rows in GET %s", async (suffix) => {
    const response = await GET(new Request(`http://localhost/api/portal-vendors${suffix}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].notes).toBe("");
    expect(JSON.stringify(body)).not.toContain("secret");
    for (const field of ["propertyIds", "messaging", "checkIns", "preferredName", "futureSecret"]) expect(body.rows[0]).not.toHaveProperty(field);
  });
});

it("removes the linked-vendor policy exposing private directory JSON", () => {
  const sql = readFileSync("supabase/migrations/20260912230000_vendor_directory_private_fields.sql", "utf8");
  expect(sql).toMatch(/drop policy if exists manager_vendor_records_vendor_read on public.manager_vendor_records/i);
});
