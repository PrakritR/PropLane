import { beforeEach, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ actor: "a", rows: new Map<string, Row>() }));
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: async () => ({ user: { id: state.actor, email: `${state.actor}@example.invalid` }, profile: {}, effectiveRole: "manager", roles: ["manager"] }) }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => {
  let mode = "select"; let payload: Row | null = null; const predicates: Array<(row: Row) => boolean> = [];
  const query = {
    select: () => query,
    eq: (key: string, value: unknown) => { predicates.push((row) => row[key] === value); return query; },
    in: (key: string, values: unknown[]) => { predicates.push((row) => values.includes(row[key])); return query; },
    limit: () => query,
    order: () => query,
    delete: () => { mode = "delete"; return query; },
    upsert: (row: Row) => { mode = "upsert"; payload = row; return query; },
    then: (resolve: (value: unknown) => void) => {
      const selected = [...state.rows.values()].filter((row) => predicates.every((predicate) => predicate(row)));
      if (mode === "upsert" && payload) state.rows.set(String(payload.id), payload);
      if (mode === "delete") for (const row of selected) state.rows.delete(String(row.id));
      return Promise.resolve({ data: mode === "upsert" ? [] : selected, error: null }).then(resolve);
    },
  };
  return query;
} }) }));
import { GET, POST } from "@/app/api/portal-pro-relationships/route";
import { relationshipStorageId } from "@/lib/auth/pro-relationship-storage-id.server";

beforeEach(() => { state.actor = "a"; state.rows.clear(); });
const post = (body: unknown) => POST(new Request("http://localhost/api/portal-pro-relationships", { method: "POST", body: JSON.stringify(body) }));

it("isolates both participants' writes, reads and logical deletes through the real route", async () => {
  state.rows.set("invite", { id: "invite", manager_user_id: "a", row_data: { id: "invite", linkedAxisId: "axis-b", linkDirection: "outgoing" } });
  state.actor = "b";
  expect((await post({ action: "replace", rows: [{ id: "invite", linkedAxisId: "axis-a", linkDirection: "incoming", managerUserId: "a", relatedUserId: "a" }] })).status).toBe(200);
  expect(state.rows.get("invite")?.manager_user_id).toBe("a");
  expect(state.rows.get(relationshipStorageId("b", "invite"))?.manager_user_id).toBe("b");
  const own = await (await GET(new Request("http://localhost/api/portal-pro-relationships"))).json();
  expect(own.rows).toHaveLength(1);
  expect(own.rows[0]).toMatchObject({ id: "invite", linkDirection: "incoming", managerUserId: "b" });
  state.actor = "a";
  expect((await post({ action: "replace", rows: [{ id: "invite", linkedAxisId: "axis-b", linkDirection: "outgoing" }] })).status).toBe(200);
  const inviter = await (await GET(new Request("http://localhost/api/portal-pro-relationships"))).json();
  expect(inviter.rows).toHaveLength(1);
  expect(inviter.rows[0]).toMatchObject({ id: "invite", linkDirection: "outgoing", managerUserId: "a" });
  state.actor = "b";
  expect((await post({ action: "delete", id: "invite" })).status).toBe(200);
  expect(state.rows.has("invite")).toBe(true);
  expect(state.rows.has(relationshipStorageId("b", "invite"))).toBe(false);
  expect(state.rows.has(relationshipStorageId("a", "invite"))).toBe(true);
  expect((await post({ action: "delete", id: "invite" })).status).toBe(404);
});
