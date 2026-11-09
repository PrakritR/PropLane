import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: new Map<string, string>(), lookupError: false, partial: false, oversight: false, grant: false, writes: [] as Array<{ op: string; id: string; owner?: string }> }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "actor" } } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => {
  if (table === "profile_roles") return { select: () => ({ eq() { return this; }, maybeSingle: async () => ({ data: null, error: null }) }) };
  let id = "";
  const builder = {
    select: () => builder,
    eq: (_key: string, value: string) => { id = value; return builder; },
    in: async (_key: string, ids: string[]) => ({ data: ids.filter((key) => state.rows.has(key)).map((key) => ({ id: key, manager_user_id: state.rows.get(key) })), error: state.lookupError ? { message: "failure" } : null }),
    maybeSingle: async () => ({ data: state.rows.has(id) && (!state.lookupError || state.partial) ? { manager_user_id: state.rows.get(id), row_data: { propertyId: "house" } } : null, error: state.lookupError ? { message: "failure" } : null }),
    upsert: async (row: { id: string; manager_user_id: string }) => { state.writes.push({ op: "upsert", id: row.id, owner: row.manager_user_id }); return { error: null }; },
    delete: () => ({ eq: (_key: string, value: string) => ({ eq: async (_ownerKey: string, owner: string) => { state.writes.push({ op: "delete", id: value, owner }); return { error: null }; }, then: (resolve: (value: unknown) => void) => resolve({ error: null }) }) }),
  };
  return builder;
} }) }));
vi.mock("@/lib/manager-route-guard.server", () => ({ userHoldsManagerRole: async () => true }));
vi.mock("@/lib/auth/admin-oversight.server", () => ({ resolveAdminOversight: async () => state.oversight }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "allowed" }) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedOwnerForProperty: async () => null, linkedOwnerScopeForModule: async () => ({ ownerIds: new Set() }), linkedPropertyIdsForModule: async () => new Set() }));
vi.mock("@/lib/auth/co-manager-access", () => ({ assertManagerPromotionCoManagerAccess: async () => state.grant ? { ok: true } : { ok: false, status: 403, error: "Forbidden" } }));
import { POST } from "@/app/api/portal-promotions/route";

const request = (body: unknown) => new Request("http://localhost/api/portal-promotions", { method: "POST", body: JSON.stringify(body) });
const row = (id: string) => ({ id, propertyId: "house", inputs: {}, status: "draft" });
beforeEach(() => { state.rows.clear(); state.lookupError = false; state.partial = false; state.oversight = false; state.grant = false; state.writes = []; });

it.each(["replace", "upsert", "delete"])("fails closed on %s ownership lookup errors, even with partial data", async (action) => {
  state.rows.set("foreign", "other"); state.rows.set("own", "actor"); state.lookupError = true; state.partial = true;
  const response = await POST(request(action === "replace" ? { action, rows: [row("own"), row("foreign")] } : action === "delete" ? { action, id: "foreign" } : { action, row: row("foreign") }));
  expect(response.status).toBe(500); expect(state.writes).toEqual([]);
});
it("canonicalizes replace IDs before lookup and never re-owns foreign rows", async () => {
  state.rows.set("foreign", "other");
  expect((await POST(request({ action: "replace", rows: [row(" foreign "), row(" new ")] }))).status).toBe(200);
  expect(state.writes).toEqual([{ op: "upsert", id: "new", owner: "actor" }]);
});
it("rejects blank IDs and writes owned or new IDs canonically", async () => {
  expect((await POST(request({ action: "upsert", row: row("  ") }))).status).toBe(400);
  expect((await POST(request({ action: "replace", rows: [row(" ")] }))).status).toBe(400);
  state.rows.set("own", "actor");
  expect((await POST(request({ action: "upsert", row: row(" own ") }))).status).toBe(200);
  expect(state.writes).toEqual([{ op: "upsert", id: "own", owner: "actor" }]);
});
it("requires co-manager permission and retains the stored owner", async () => {
  state.rows.set("foreign", "other");
  expect((await POST(request({ action: "upsert", row: row(" foreign ") }))).status).toBe(403);
  state.grant = true;
  expect((await POST(request({ action: "upsert", row: row(" foreign ") }))).status).toBe(200);
  expect(state.writes).toEqual([{ op: "upsert", id: "foreign", owner: "other" }]);
});
it("preserves explicit oversight and owner-scoped delete behavior", async () => {
  state.rows.set("foreign", "other"); state.oversight = true;
  expect((await POST(request({ action: "replace", rows: [row(" foreign ")] }))).status).toBe(200);
  expect(state.writes).toEqual([{ op: "upsert", id: "foreign", owner: "actor" }]);
  state.oversight = false;
  expect((await POST(request({ action: "delete", id: " own " }))).status).toBe(200);
  expect(state.writes.at(-1)).toEqual({ op: "delete", id: "own", owner: "actor" });
});
