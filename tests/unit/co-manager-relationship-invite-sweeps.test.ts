import { beforeEach, expect, it, vi } from "vitest";
import { relationshipStorageId } from "@/lib/auth/pro-relationship-storage-id.server";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ invites: [] as Row[], mirrors: [] as Row[] }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "a" } } }) } }) }));
vi.mock("@/lib/property-owner/route-auth.server", () => ({ refuseOwnerOnly: async () => null }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ assertTestWorkspacePrincipalCompatibility: async () => undefined }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => {
  let mode = "select"; let patch: Row = {}; const predicates: Array<(row: Row) => boolean> = [];
  const matches = () => (table === "account_link_invites" ? state.invites : state.mirrors).filter((row) => predicates.every((fn) => fn(row)));
  const value = (row: Row, key: string) => key.startsWith("row_data->>") ? (row.row_data as Row)?.[key.slice(11)] : row[key];
  const run = () => {
    const rows = matches();
    if (mode === "delete") state.mirrors = state.mirrors.filter((row) => !rows.includes(row));
    if (mode === "update") for (const row of rows) Object.assign(row, patch);
    return { data: rows, error: null };
  };
  const query = {
    select: () => query, eq: (key: string, v: unknown) => { predicates.push((row) => value(row, key) === v); return query; },
    filter: (key: string, _op: string, v: unknown) => { predicates.push((row) => value(row, key) === v); return query; },
    update: (v: Row) => { mode = "update"; patch = v; return query; }, delete: () => { mode = "delete"; return query; },
    maybeSingle: async () => { const result = run(); return { ...result, data: result.data[0] ?? null }; },
    then: (resolve: (v: unknown) => void) => Promise.resolve(run()).then(resolve),
  };
  return query;
} }) }));
import { PATCH } from "@/app/api/pro/account-links/[inviteId]/route";

beforeEach(() => {
  state.invites = [{ id: "one", inviter_user_id: "a", invitee_user_id: "b", inviter_axis_id: "axis-a", invitee_axis_id: "axis-b", status: "accepted", assigned_property_ids: [], co_manager_permissions: {}, property_co_manager_permissions: {} }];
  state.mirrors = ["one", "two"].flatMap((id) => [
    { id: relationshipStorageId("a", id), manager_user_id: "a", row_data: { id, linkedAxisId: "axis-b", marker: id } },
    { id: relationshipStorageId("b", id), manager_user_id: "b", row_data: { id, linkedAxisId: "axis-a", marker: id } },
  ]);
});
const patch = (body: unknown) => PATCH(new Request("http://localhost/api/pro/account-links/one", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ inviteId: "one" }) });

it("revokes only the target invite's mirrors for both participants", async () => {
  expect((await patch({ action: "revoke" })).status).toBe(200);
  expect(state.mirrors.map((row) => (row.row_data as Row).id)).toEqual(["two", "two"]);
});

it("updates only the target invite's mirrors when permissions change", async () => {
  expect((await patch({ coManagerPermissions: { properties: true } })).status).toBe(200);
  const one = state.mirrors.filter((row) => (row.row_data as Row).id === "one");
  const two = state.mirrors.filter((row) => (row.row_data as Row).id === "two");
  expect(one).toHaveLength(2);
  expect(one.every((row) => Object.hasOwn(row.row_data as Row, "assignedPropertyIds"))).toBe(true);
  expect(two.every((row) => !Object.hasOwn(row.row_data as Row, "assignedPropertyIds"))).toBe(true);
});
