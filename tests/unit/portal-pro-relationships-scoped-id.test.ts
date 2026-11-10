import { expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ config: null as unknown }));
vi.mock("@/lib/portal-record-api", () => ({ createJsonRecordRoute: (config: unknown) => { captured.config = config; return { GET: vi.fn(), POST: vi.fn() }; } }));
import "@/app/api/portal-pro-relationships/route";
import { relationshipStorageId } from "@/lib/auth/pro-relationship-storage-id.server";

type User = { id: string; role: string };
type Row = { id: string; manager_user_id: string; row_data: Record<string, unknown> };
type Config = {
  buildUpsert: (row: Record<string, unknown>, user: User) => Row & { related_user_id: null; related_email: null };
  projectRead: (args: { user: User; records: Row[] }) => Promise<Row[]>;
  resolveDeleteIds: (args: { db: unknown; user: User; ids: string[] }) => Promise<string[]>;
  scope: (query: unknown, user: User) => unknown;
};
const config = captured.config as Config;
const a = { id: "manager-a", role: "manager" }, b = { id: "manager-b", role: "admin" };

function dbFor(rows: Row[]) {
  return { from: () => ({ select: () => ({ eq: (_column: string, owner: string) => ({ in: async (_key: string, ids: string[]) => ({ data: rows.filter((row) => row.manager_user_id === owner && ids.includes(row.id)), error: null }) }) }) }) };
}

it("stores both invite perspectives separately, pins actor and retains the logical id", () => {
  const base = { id: "invite", linkedAxisId: "other", managerUserId: "forged", relatedUserId: "foreign", relatedEmail: "foreign@example.invalid" };
  const left = config.buildUpsert({ ...base, linkDirection: "outgoing" }, a);
  const right = config.buildUpsert({ ...base, linkDirection: "incoming" }, b);
  expect(left.id).not.toBe(right.id);
  expect(left.row_data).toMatchObject({ id: "invite", managerUserId: a.id, linkDirection: "outgoing" });
  expect(right.row_data).toMatchObject({ id: "invite", managerUserId: b.id, linkDirection: "incoming" });
  expect(right).toMatchObject({ manager_user_id: b.id, related_user_id: null, related_email: null });
  expect(right.row_data).not.toHaveProperty("relatedUserId");
  expect(right.row_data).not.toHaveProperty("relatedEmail");
  const eq = vi.fn(); config.scope({ eq }, b); expect(eq).toHaveBeenCalledWith("manager_user_id", b.id);
});

it("prefers the viewer's scoped row to its legacy row without changing logical id", async () => {
  const legacy: Row = { id: "invite", manager_user_id: a.id, row_data: { id: "invite", value: "legacy" } };
  const scoped = { ...legacy, id: relationshipStorageId(a.id, "invite"), row_data: { id: "invite", value: "scoped" } };
  expect(await config.projectRead({ user: a, records: [legacy, scoped] })).toEqual([scoped]);
  expect(await config.projectRead({ user: a, records: [scoped, legacy] })).toEqual([scoped]);
});

it("deletes only the actor's legacy and scoped records and refuses foreign or incomplete requests", async () => {
  const legacy: Row = { id: "invite", manager_user_id: a.id, row_data: { id: "invite" } };
  const own = { ...legacy, id: relationshipStorageId(a.id, "invite") };
  const foreign = { ...legacy, id: relationshipStorageId(b.id, "invite"), manager_user_id: b.id };
  const db = dbFor([legacy, own, foreign]);
  expect(new Set(await config.resolveDeleteIds({ db, user: a, ids: ["invite"] }))).toEqual(new Set([legacy.id, own.id]));
  expect(await config.resolveDeleteIds({ db, user: b, ids: ["invite"] })).toEqual([foreign.id]);
  expect(await config.resolveDeleteIds({ db, user: a, ids: ["invite", "unknown"] })).toEqual([]);
  expect(await config.resolveDeleteIds({ db, user: { id: "manager-c", role: "manager" }, ids: ["invite"] })).toEqual([]);
});
