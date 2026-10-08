import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const deleteOwnPortalAccount = vi.fn(async (..._args: unknown[]) => ({ ok: true }));

vi.mock("@/lib/auth/manager-application-access", () => ({ managerCanAccessApplicationRecord: async () => true }));
vi.mock("@/lib/auth/purge-account-storage", () => ({ purgeAccountStorageFolder: async () => undefined }));
vi.mock("@/lib/auth/delete-portal-account", () => ({
  deleteOwnPortalAccount: (...args: unknown[]) => deleteOwnPortalAccount(...args),
  // Same union the real helper reads: profile_roles plus the legacy profiles.role.
  normalizedRolesForUser: async (db: { from: (t: string) => { select: () => { eq: (c: string, v: string) => PromiseLike<{ data: Row[] }> } } }, id: string) => {
    const { data } = await db.from("profile_roles").select().eq("user_id", id);
    return data.map((row) => String(row.role));
  },
}));

import { removeResidentApplication, previewResidentApplicationRemoval } from "@/lib/auth/remove-resident-application";
import { decideResidentAccountFate } from "@/lib/auth/resident-account-deletion";

const MANAGER = "manager-a";
const OTHER_MANAGER = "manager-b";
const RESIDENT = "resident-1";
const EMAIL = "resident@example.com";
const WORKSPACE = "ws-a";
const RESIDENT_SCOPE = "axis_portal_inbox_resident_v1";

function database(seed: Record<string, Row[]>) {
  const rows = structuredClone(seed);
  const db = {
    async rpc(name: string, args: { p_manager: string; p_targets: { table: string; ids: string[] }[] }) {
      if (name !== "purge_manager_resident_rows_v2") throw new Error(`unexpected rpc ${name}`);
      const deleted: Record<string, number> = {};
      for (const target of args.p_targets) {
        const ownerColumn = target.table === "portal_inbox_thread_records" ? "owner_user_id" : target.table.startsWith("resident_autopay") ? "manager_id" : "manager_user_id";
        const before = rows[target.table] ?? [];
        rows[target.table] = before.filter((row) => !(target.ids.includes(String(row.id)) && row[ownerColumn] === args.p_manager));
        deleted[target.table] = before.length - rows[target.table].length;
      }
      return { error: null, data: { deleted, anonymized: {} } };
    },
    from(table: string) {
      const predicates: ((row: Row) => boolean)[] = [];
      let action = "select";
      let offset = 0;
      let end = Infinity;
      const read = (row: Row, column: string) => {
        const [key, nested] = column.split("->>");
        return nested ? (row[key] as Row | undefined)?.[nested] : row[key];
      };
      const query = {
        select() { return query; },
        order() { return query; },
        range(from: number, to: number) { offset = from; end = to + 1; return query; },
        delete() { action = "delete"; return query; },
        eq(column: string, value: unknown) { predicates.push((row) => read(row, column) === value); return query; },
        // PostgREST drops NULL on <>, so an unstamped row is never "another manager's".
        neq(column: string, value: unknown) { predicates.push((row) => read(row, column) != null && read(row, column) !== value); return query; },
        in(column: string, values: unknown[]) { predicates.push((row) => values.includes(read(row, column))); return query; },
        ilike(column: string, value: string) {
          const literal = value.replace(/\\([\\%_])/g, "$1").toLowerCase();
          predicates.push((row) => String(read(row, column) ?? "").toLowerCase() === literal);
          return query;
        },
        filter(column: string, op: string, value: string) { return op === "ilike" ? query.ilike(column, value) : query.eq(column, value); },
        async maybeSingle() { return { data: (rows[table] ?? []).find((row) => predicates.every((p) => p(row))) ?? null, error: null }; },
        then(resolve: (result: { data: Row[]; error: null }) => void) {
          const matched = (rows[table] ?? []).filter((row) => predicates.every((p) => p(row))).slice(offset, end);
          if (action === "delete") rows[table] = (rows[table] ?? []).filter((row) => !matched.includes(row));
          resolve({ data: matched, error: null });
        },
      };
      return query;
    },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ error: null }) }) },
    auth: {
      admin: {
        getUserById: async (id: string) => {
          const profile = rows.profiles?.find((row) => row.id === id);
          return profile ? { data: { user: { id, email: profile.email } }, error: null } : { data: { user: null }, error: null };
        },
      },
    },
  };
  return { db, rows };
}

/** A resident whose only tie is manager A's application and one conversation in A's workspace. */
function baseSeed(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    profiles: [
      { id: RESIDENT, email: EMAIL, role: "resident" },
      { id: MANAGER, email: "manager-a@example.com", role: "manager" },
    ],
    profile_roles: [{ user_id: RESIDENT, role: "resident" }],
    portal_workspaces: [{ id: WORKSPACE, owner_user_id: MANAGER }],
    manager_application_records: [{ id: "app-a", manager_user_id: MANAGER, resident_email: EMAIL }],
    portal_inbox_thread_records: [
      // The resident's own copy of the conversation with manager A's workspace.
      { id: "thread-own", scope: RESIDENT_SCOPE, owner_user_id: RESIDENT, participant_email: EMAIL, workspace_id: WORKSPACE, conversation_key: `ws:${WORKSPACE}`, row_data: { email: "manager-a@example.com" } },
      // Manager A's copy.
      { id: "thread-mgr", scope: "axis_portal_inbox_manager_v1", owner_user_id: MANAGER, participant_email: EMAIL, row_data: { email: EMAIL } },
    ],
    ...overrides,
  };
}

const actor = { userId: MANAGER, isAdmin: false };
const input = { applicationId: "app-a", email: EMAIL };

beforeEach(() => {
  deleteOwnPortalAccount.mockClear();
});

describe("deleting a resident deletes their PropLane account only when nothing else holds it", () => {
  it("resident-only with no other relationship: the account is purged through the self-delete path", async () => {
    const { db, rows } = database(baseSeed());
    const preview = await previewResidentApplicationRemoval(db as never, actor, input);
    expect(preview).toMatchObject({ ok: true, account: "deleted" });
    expect(deleteOwnPortalAccount).not.toHaveBeenCalled();

    const result = await removeResidentApplication(db as never, actor, input);
    expect(result).toMatchObject({ ok: true, account: "deleted" });
    expect(deleteOwnPortalAccount).toHaveBeenCalledTimes(1);
    expect(deleteOwnPortalAccount).toHaveBeenCalledWith(db, RESIDENT, "resident");
    expect(rows.manager_application_records).toEqual([]);
    expect(rows.portal_inbox_thread_records).toEqual([]);
  });

  it("a resident who also holds a vendor role keeps the account, but loses the workspace rows", async () => {
    const { db, rows } = database(baseSeed({
      profile_roles: [{ user_id: RESIDENT, role: "resident" }, { user_id: RESIDENT, role: "vendor" }],
    }));
    expect(await previewResidentApplicationRemoval(db as never, actor, input)).toMatchObject({ account: "kept" });
    const result = await removeResidentApplication(db as never, actor, input);
    expect(result).toMatchObject({ ok: true, account: "kept" });
    expect(deleteOwnPortalAccount).not.toHaveBeenCalled();
    expect(rows.manager_application_records).toEqual([]);
    // The resident's own workspace conversation goes even though the login stays.
    expect(rows.portal_inbox_thread_records).toEqual([]);
  });

  it.each(["manager", "owner", "admin"])("a %s role keeps the account", async (role) => {
    const { db } = database(baseSeed({ profile_roles: [{ user_id: RESIDENT, role: "resident" }, { user_id: RESIDENT, role }] }));
    expect(await decideResidentAccountFate(db as never, { actorUserId: MANAGER, managerUserId: MANAGER, email: EMAIL, residentUserId: RESIDENT }))
      .toMatchObject({ status: "keep", reason: "other_roles" });
  });

  it("a charge from another manager keeps the account", async () => {
    const { db, rows } = database(baseSeed({
      portal_household_charge_records: [{ id: "charge-b", manager_user_id: OTHER_MANAGER, resident_email: EMAIL }],
    }));
    const result = await removeResidentApplication(db as never, actor, input);
    expect(result).toMatchObject({ ok: true, account: "kept" });
    expect(deleteOwnPortalAccount).not.toHaveBeenCalled();
    expect(rows.portal_household_charge_records).toHaveLength(1);
    expect(rows.manager_application_records).toEqual([]);
  });

  it.each([
    ["an application", { manager_application_records: [{ id: "app-a", manager_user_id: MANAGER, resident_email: EMAIL }, { id: "app-b", manager_user_id: OTHER_MANAGER, resident_email: EMAIL }] }],
    ["a lease", { portal_lease_pipeline_records: [{ id: "lease-b", manager_user_id: OTHER_MANAGER, resident_email: EMAIL }] }],
    ["a service request", { portal_service_request_records: [{ id: "svc-b", manager_user_id: OTHER_MANAGER, resident_email: EMAIL }] }],
    ["a work order", { portal_work_order_records: [{ id: "wo-b", manager_user_id: OTHER_MANAGER, resident_email: EMAIL }] }],
    ["a rent profile", { portal_recurring_rent_profile_records: [{ id: "rent-b", manager_user_id: OTHER_MANAGER, resident_id: RESIDENT, resident_user_id: RESIDENT }] }],
    ["a team membership", { account_link_invites: [{ id: "inv", inviter_user_id: OTHER_MANAGER, invitee_user_id: RESIDENT }] }],
    ["another manager's conversation", { portal_inbox_thread_records: [
      { id: "thread-own", scope: RESIDENT_SCOPE, owner_user_id: RESIDENT, participant_email: EMAIL, workspace_id: WORKSPACE, conversation_key: `ws:${WORKSPACE}`, row_data: { email: "manager-a@example.com" } },
      { id: "thread-b", scope: RESIDENT_SCOPE, owner_user_id: RESIDENT, participant_email: EMAIL, workspace_id: "ws-b", conversation_key: "ws:ws-b", row_data: { email: "manager-b@example.com" } },
    ] }],
  ] as [string, Record<string, Row[]>][])("%s with another manager keeps the account", async (_name, extra) => {
    const { db } = database(baseSeed(extra));
    expect(await decideResidentAccountFate(db as never, { actorUserId: MANAGER, managerUserId: MANAGER, email: EMAIL, residentUserId: RESIDENT }))
      .toMatchObject({ status: "keep", reason: "other_relationships" });
  });

  it("the other workspace's conversation survives; this workspace's goes", async () => {
    const { db, rows } = database(baseSeed({
      portal_inbox_thread_records: [
        { id: "thread-own", scope: RESIDENT_SCOPE, owner_user_id: RESIDENT, participant_email: EMAIL, workspace_id: WORKSPACE, conversation_key: `ws:${WORKSPACE}`, row_data: { email: "manager-a@example.com" } },
        { id: "thread-b", scope: RESIDENT_SCOPE, owner_user_id: RESIDENT, participant_email: EMAIL, workspace_id: "ws-b", conversation_key: "ws:ws-b", row_data: { email: "manager-b@example.com" } },
      ],
    }));
    await removeResidentApplication(db as never, actor, input);
    expect(rows.portal_inbox_thread_records.map((row) => row.id)).toEqual(["thread-b"]);
    expect(deleteOwnPortalAccount).not.toHaveBeenCalled();
  });

  it("the acting manager is never deleted, even if their own address is the application's", async () => {
    const { db, rows } = database(baseSeed());
    const result = await removeResidentApplication(db as never, { userId: RESIDENT, isAdmin: false }, input);
    expect(result).toMatchObject({ ok: true, account: "kept" });
    expect(deleteOwnPortalAccount).not.toHaveBeenCalled();
    expect(rows.profiles.map((row) => row.id)).toContain(RESIDENT);
    expect(await decideResidentAccountFate(db as never, { actorUserId: RESIDENT, managerUserId: MANAGER, email: EMAIL, residentUserId: RESIDENT }))
      .toMatchObject({ status: "keep", reason: "is_actor" });
  });

  it("an account whose Auth email is not the application's is kept", async () => {
    const { db } = database(baseSeed({ profiles: [{ id: RESIDENT, email: "someone-else@example.com", role: "resident" }] }));
    expect(await decideResidentAccountFate(db as never, { actorUserId: MANAGER, managerUserId: MANAGER, email: EMAIL, residentUserId: RESIDENT }))
      .toMatchObject({ status: "keep", reason: "identity_mismatch" });
  });

  it("a resident who never signed up has no account to delete", async () => {
    const { db } = database(baseSeed({ profiles: [], profile_roles: [] }));
    expect(await decideResidentAccountFate(db as never, { actorUserId: MANAGER, managerUserId: MANAGER, email: EMAIL, residentUserId: null }))
      .toEqual({ status: "none" });
    const result = await removeResidentApplication(db as never, actor, input);
    expect(result).toMatchObject({ ok: true, account: "none" });
    expect(deleteOwnPortalAccount).not.toHaveBeenCalled();
  });

  it("an unreadable relationship check keeps the account instead of guessing", async () => {
    const { db } = database(baseSeed());
    const from = db.from.bind(db);
    db.from = ((table: string) => {
      if (table === "portal_lease_pipeline_records") throw new Error("read failed");
      return from(table);
    }) as never;
    expect(await decideResidentAccountFate(db as never, { actorUserId: MANAGER, managerUserId: MANAGER, email: EMAIL, residentUserId: RESIDENT }))
      .toMatchObject({ status: "keep", reason: "unreadable" });
  });

  it("a failed account purge is reported, not thrown, and the workspace rows stay removed", async () => {
    deleteOwnPortalAccount.mockRejectedValueOnce(new Error("Stripe offline"));
    const { db, rows } = database(baseSeed());
    const result = await removeResidentApplication(db as never, actor, input);
    expect(result).toMatchObject({ ok: true, account: "failed", accountError: "Stripe offline" });
    expect(rows.manager_application_records).toEqual([]);
  });
});
