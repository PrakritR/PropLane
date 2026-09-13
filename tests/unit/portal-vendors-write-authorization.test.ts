import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), admin: vi.fn(), scope: vi.fn(), db: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: mocks.user } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.db }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: mocks.admin }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedOwnerScopeForModule: mocks.scope }));
vi.mock("@/lib/manager-vendors-storage", () => ({
  isVendorCategorySettingsRow: (row: { name?: string }) => row.name === "__vendor_category_settings__",
  managerVendorCategorySettingsRowId: (owner: string) => `categories:${owner}`,
}));
import { POST } from "@/app/api/portal-vendors/route";

type Row = Record<string, unknown>;
function fixture() {
  const tables: Record<string, Row[]> = {
    profiles: [{ id: "actor", role: "manager" }],
    manager_vendor_records: [{ id: "vendor", manager_user_id: "other", row_data: { name: "Original" } }],
    manager_property_records: [{ id: "own-house", manager_user_id: "actor" }, { id: "other-house", manager_user_id: "other" }],
  };
  const writes: { table: string; operation: string; filters: [string, unknown][]; value: Row | undefined }[] = [];
  const failures = new Set<string>();
  let beforeWrite: (() => void) | undefined;
  const db = { from(table: string) {
    let operation = "read";
    let value: Row | undefined;
    let single = false;
    let maxRows = Infinity;
    const filters: [string, unknown][] = [];
    const included: [string, unknown[]][] = [];
    const query = {
      select() { return query; },
      eq(key: string, expected: unknown) { filters.push([key, expected]); return query; },
      in(key: string, expected: unknown[]) { included.push([key, expected]); return query; },
      limit(max: number) { maxRows = max; return query; },
      maybeSingle() { single = true; return query; },
      update(next: Row) { operation = "update"; value = next; return query; },
      insert(next: Row) { operation = "insert"; value = next; return query; },
      delete() { operation = "delete"; return query; },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        const execute = () => {
          if (operation === "read" && failures.has(table)) return { data: null, error: { message: "lookup unavailable" } };
          if (operation !== "read") {
            writes.push({ table, operation, filters, value });
            beforeWrite?.(); beforeWrite = undefined;
          }
          const rows = tables[table] ?? [];
          const matches = rows.filter(row => filters.every(([key, expected]) => row[key] === expected) && included.every(([key, expected]) => expected.includes(row[key])));
          let result = matches;
          if (operation === "insert") {
            if (rows.some(row => row.id === value?.id)) return { data: null, error: { code: "23505" } };
            rows.push(value!); result = [value!];
          } else if (operation === "update") matches.forEach(row => Object.assign(row, value));
          else if (operation === "delete") tables[table] = rows.filter(row => !matches.includes(row));
          result = result.slice(0, maxRows);
          return { data: single ? result[0] ?? null : result, error: null };
        };
        return Promise.resolve().then(execute).then(resolve, reject);
      },
    };
    return query;
  } };
  mocks.db.mockReturnValue(db);
  return { tables, writes, failures, beforeWrite: (callback: () => void) => { beforeWrite = callback; } };
}
const row = (overrides: Row = {}) => ({ id: "vendor", managerUserId: "actor", name: "Changed", propertyId: "own-house", ...overrides });
const request = (body: unknown = { action: "upsert", row: row() }) => new Request("https://example.test/api/portal-vendors", { method: "POST", body: JSON.stringify(body) });
function grant(owner = "other", property = "other-house") {
  mocks.scope.mockResolvedValue({ ownerIds: new Set([owner]), propertyIds: new Set([property]), propertyIdsByOwner: new Map([[owner, new Set([property])]]) });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ data: { user: { id: "actor" } } });
  mocks.admin.mockResolvedValue(false);
  mocks.scope.mockResolvedValue({ ownerIds: new Set(), propertyIds: new Set(), propertyIdsByOwner: new Map() });
});

describe("vendor writes use stored owner and current services grants", () => {
  it("rejects a foreign vendor even with the actor's own property and spoofed owner", async () => {
    const f = fixture();
    expect((await POST(request())).status).toBe(403);
    expect(f.writes).toEqual([]);
    expect(f.tables.manager_vendor_records[0].row_data).toEqual({ name: "Original" });
  });
  it("does not borrow a services grant from another owner", async () => {
    const f = fixture(); grant("different", "own-house");
    expect((await POST(request())).status).toBe(403);
    expect(f.writes).toEqual([]);
  });
  it("preserves legitimate owner-bound services edit without trusting property input", async () => {
    const f = fixture(); grant();
    expect((await POST(request({ action: "upsert", row: row({ propertyId: undefined }) }))).status).toBe(200);
    expect(mocks.scope).toHaveBeenCalledWith(expect.anything(), "actor", "services", "edit", { throwOnError: true });
    expect(f.writes[0]).toMatchObject({ operation: "update", filters: [["id", "vendor"], ["manager_user_id", "other"]] });
    expect(f.tables.manager_vendor_records[0]).toMatchObject({ manager_user_id: "other", row_data: { managerUserId: "other", name: "Changed" } });
  });
  it("rejects an old owner grant after the property was transferred", async () => {
    const f = fixture(); grant(); f.tables.manager_property_records[1].manager_user_id = "new-owner";
    expect((await POST(request())).status).toBe(403);
    expect(f.writes).toEqual([]);
  });
  it.each(["manager_vendor_records", "manager_property_records"])("fails closed on %s lookup failure", async table => {
    const f = fixture(); grant(); f.failures.add(table);
    expect((await POST(request())).status).toBeGreaterThanOrEqual(500);
    expect(f.writes).toEqual([]);
  });
  it("fails closed when the services resolver cannot verify grants", async () => {
    const f = fixture(); mocks.scope.mockRejectedValue(new Error("unavailable"));
    expect((await POST(request())).status).toBe(500);
    expect(f.writes).toEqual([]);
  });
  it("does not claim an existing ownerless vendor", async () => {
    const f = fixture(); f.tables.manager_vendor_records[0].manager_user_id = null;
    expect((await POST(request())).status).toBe(403);
    expect(f.writes).toEqual([]);
  });
  it("inserts a new record under the actor only", async () => {
    const f = fixture();
    expect((await POST(request({ row: row({ id: "new", managerUserId: "spoofed" }) }))).status).toBe(200);
    expect(f.writes[0]).toMatchObject({ operation: "insert", value: { manager_user_id: "actor", row_data: { managerUserId: "actor" } } });
  });
  it("allows an owner edit without a co-manager grant", async () => {
    const f = fixture(); f.tables.manager_vendor_records[0].manager_user_id = "actor";
    expect((await POST(request())).status).toBe(200);
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(f.writes[0]).toMatchObject({ operation: "update", filters: [["id", "vendor"], ["manager_user_id", "actor"]] });
  });
  it("returns conflict when another owner acquires the id before insert", async () => {
    const f = fixture(); f.beforeWrite(() => f.tables.manager_vendor_records.push({ id: "new", manager_user_id: "other" }));
    expect((await POST(request({ row: row({ id: "new" }) }))).status).toBe(409);
    expect(f.tables.manager_vendor_records.find(record => record.id === "new")?.manager_user_id).toBe("other");
  });
  it("returns conflict when ownership changes before update", async () => {
    const f = fixture(); grant(); f.beforeWrite(() => { f.tables.manager_vendor_records[0].manager_user_id = "new-owner"; });
    expect((await POST(request())).status).toBe(409);
    expect(f.tables.manager_vendor_records[0]).toMatchObject({ manager_user_id: "new-owner", row_data: { name: "Original" } });
  });
  it("checks every replacement row before making any write", async () => {
    const f = fixture();
    expect((await POST(request({ action: "replace", rows: [row({ id: "new" }), row()] }))).status).toBe(403);
    expect(f.writes).toEqual([]);
  });
  it("preserves ownership even for an administrator's edit", async () => {
    const f = fixture(); mocks.admin.mockResolvedValue(true);
    expect((await POST(request())).status).toBe(200);
    expect(f.tables.manager_vendor_records[0].manager_user_id).toBe("other");
  });
  it("canonicalizes the category id before checking its stored owner", async () => {
    const f = fixture(); f.tables.manager_vendor_records.push({ id: "categories:actor", manager_user_id: "other" });
    expect((await POST(request({ row: row({ id: "innocent", name: "__vendor_category_settings__" }) }))).status).toBe(403);
    expect(f.writes).toEqual([]);
  });
  it("rejects unauthenticated writes before database access", async () => {
    fixture(); mocks.user.mockResolvedValue({ data: { user: null } });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it("rejects a resident portal actor before vendor reads or writes", async () => {
    const f = fixture(); f.tables.profiles[0].role = "resident";
    expect((await POST(request())).status).toBe(403);
    expect(f.writes).toEqual([]);
    expect(mocks.scope).not.toHaveBeenCalled();
  });
});
