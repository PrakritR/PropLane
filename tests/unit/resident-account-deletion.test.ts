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
import {
  decideResidentAccountFate,
  residentDirectRelationshipSources,
  residentRelationshipSources,
} from "@/lib/auth/resident-account-deletion";

const MANAGER = "manager-a";
const OTHER_MANAGER = "manager-b";
const RESIDENT = "resident-1";
const EMAIL = "resident@example.com";
const WORKSPACE = "ws-a";
const RESIDENT_SCOPE = "axis_portal_inbox_resident_v1";

/** Top-level comma split that leaves `and(a,b)` whole. */
function splitTerms(expr: string): string[] {
  const terms: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of expr) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) { terms.push(current); current = ""; } else current += char;
  }
  terms.push(current);
  return terms;
}

function database(seed: Record<string, Row[]>, missingTables: string[] = []) {
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
        not(column: string, op: string, value: string) {
          if (op !== "in") throw new Error(`unsupported not ${op}`);
          const values = value.replace(/^\(|\)$/g, "").split(",");
          predicates.push((row) => !values.includes(String(read(row, column))));
          return query;
        },
        // PostgREST or(): `col.is.null`, `col.neq.v`, `col.eq.v`, and `and(...)` groups.
        or(expr: string) {
          const term = (text: string): ((row: Row) => boolean) => {
            if (text.startsWith("and(")) {
              const parts = splitTerms(text.slice(4, -1)).map(term);
              return (row) => parts.every((part) => part(row));
            }
            const [column, op, ...rest] = text.split(".");
            const value = rest.join(".");
            if (op === "is" && value === "null") return (row) => read(row, column) == null;
            if (op === "neq") return (row) => read(row, column) != null && String(read(row, column)) !== value;
            if (op === "eq") return (row) => String(read(row, column)) === value;
            throw new Error(`unsupported or term ${text}`);
          };
          const parts = splitTerms(expr).map(term);
          predicates.push((row) => parts.some((part) => part(row)));
          return query;
        },
        filter(column: string, op: string, value: string) { return op === "ilike" ? query.ilike(column, value) : query.eq(column, value); },
        async maybeSingle() { return { data: (rows[table] ?? []).find((row) => predicates.every((p) => p(row))) ?? null, error: null }; },
        then(resolve: (result: { data: Row[]; error: { code: string; message: string } | null }) => void) {
          if (missingTables.includes(table)) return resolve({ data: [], error: { code: "42P01", message: `relation "${table}" does not exist` } });
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
    // Written only by the resident's own signed-in application submit.
    resident_workspace_bindings: [{ resident_user_id: RESIDENT, manager_user_id: MANAGER }],
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
    // The real purge removes every resident-owned inbox row; stand in for it.
    deleteOwnPortalAccount.mockImplementationOnce(async (_db: unknown, userId: unknown) => {
      rows.portal_inbox_thread_records = rows.portal_inbox_thread_records.filter((row) => row.owner_user_id !== userId);
      return { ok: true };
    });
    const preview = await previewResidentApplicationRemoval(db as never, actor, input);
    expect(preview).toMatchObject({ ok: true, account: "deleted" });
    expect(deleteOwnPortalAccount).not.toHaveBeenCalled();

    const result = await removeResidentApplication(db as never, actor, input);
    expect(result).toMatchObject({ ok: true, account: "deleted" });
    expect(deleteOwnPortalAccount).toHaveBeenCalledTimes(1);
    expect(deleteOwnPortalAccount).toHaveBeenCalledWith(db, RESIDENT, "resident");
    // Manager's copy + the resident's own copy, counted once the login actually went.
    expect(result).toMatchObject({ removed: { conversations: 2 }, total: 3 });
    expect(rows.manager_application_records).toEqual([]);
    expect(rows.portal_inbox_thread_records).toEqual([]);
  });

  it("a manager-created application with a victim's email keeps the victim's login", async () => {
    // Resident-only, no other relationship, email matches - but the victim never bound themselves
    // to this manager (no resident_workspace_bindings row): the email was typed by the manager.
    const { db, rows } = database(baseSeed({ resident_workspace_bindings: [] }));
    expect(await previewResidentApplicationRemoval(db as never, actor, input)).toMatchObject({ ok: true, account: "kept" });
    expect(await decideResidentAccountFate(db as never, { actorUserId: MANAGER, managerUserId: MANAGER, email: EMAIL, residentUserId: RESIDENT }))
      .toMatchObject({ status: "keep", reason: "unverified_link" });
    const result = await removeResidentApplication(db as never, actor, input);
    expect(result).toMatchObject({ ok: true, account: "kept" });
    expect(deleteOwnPortalAccount).not.toHaveBeenCalled();
    expect(rows.profiles.map((row) => row.id)).toContain(RESIDENT);
    expect(rows.manager_application_records).toEqual([]);
  });

  it("a binding to a DIFFERENT manager is not proof for this one", async () => {
    const { db } = database(baseSeed({ resident_workspace_bindings: [{ resident_user_id: RESIDENT, manager_user_id: OTHER_MANAGER }] }));
    expect(await decideResidentAccountFate(db as never, { actorUserId: MANAGER, managerUserId: MANAGER, email: EMAIL, residentUserId: RESIDENT }))
      .toMatchObject({ status: "keep", reason: "unverified_link" });
  });

  it("a resident-self-submitted application (bound to this manager) deletes the login", async () => {
    const { db } = database(baseSeed());
    expect(await decideResidentAccountFate(db as never, { actorUserId: MANAGER, managerUserId: MANAGER, email: EMAIL, residentUserId: RESIDENT }))
      .toEqual({ status: "delete", userId: RESIDENT });
  });

  it("a resident who also holds a vendor role keeps the account AND their own conversations; only the workspace rows go", async () => {
    const { db, rows } = database(baseSeed({
      profile_roles: [{ user_id: RESIDENT, role: "resident" }, { user_id: RESIDENT, role: "vendor" }],
    }));
    expect(await previewResidentApplicationRemoval(db as never, actor, input)).toMatchObject({ account: "kept" });
    const result = await removeResidentApplication(db as never, actor, input);
    expect(result).toMatchObject({ ok: true, account: "kept" });
    expect(deleteOwnPortalAccount).not.toHaveBeenCalled();
    expect(rows.manager_application_records).toEqual([]);
    // The login stays, so the resident's own copy of the conversation stays; the manager's copy goes.
    expect(rows.portal_inbox_thread_records.map((row) => row.id)).toEqual(["thread-own"]);
    expect(result).toMatchObject({ removed: { conversations: 1 } });
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

  it("a conversation with another workspace keeps the login, so none of the resident's own threads are deleted", async () => {
    const { db, rows } = database(baseSeed({
      portal_inbox_thread_records: [
        { id: "thread-own", scope: RESIDENT_SCOPE, owner_user_id: RESIDENT, participant_email: EMAIL, workspace_id: WORKSPACE, conversation_key: `ws:${WORKSPACE}`, row_data: { email: "manager-a@example.com" } },
        { id: "thread-b", scope: RESIDENT_SCOPE, owner_user_id: RESIDENT, participant_email: EMAIL, workspace_id: "ws-b", conversation_key: "ws:ws-b", row_data: { email: "manager-b@example.com" } },
      ],
    }));
    await removeResidentApplication(db as never, actor, input);
    expect(rows.portal_inbox_thread_records.map((row) => row.id).sort()).toEqual(["thread-b", "thread-own"]);
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
    // A manager cannot tell "no login" from "login kept"; an admin can.
    expect(await previewResidentApplicationRemoval(db as never, actor, input)).toMatchObject({ ok: true, account: "kept" });
    expect(await previewResidentApplicationRemoval(db as never, { userId: "admin-1", isAdmin: true }, input)).toMatchObject({ ok: true, account: "none" });
    const result = await removeResidentApplication(db as never, actor, input);
    expect(result).toMatchObject({ ok: true, account: "kept" });
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
    // A manager learns nothing about the login: "failed" would say one existed, and
    // the provider's own message is operator detail. Both are kept for an admin.
    expect(result).toMatchObject({ ok: true, account: "kept" });
    expect(result).not.toHaveProperty("accountError");
    deleteOwnPortalAccount.mockRejectedValueOnce(new Error("Stripe offline"));
    const asAdmin = await removeResidentApplication(
      database(baseSeed()).db as never,
      { userId: "admin-1", isAdmin: true },
      input,
    );
    expect(asAdmin).toMatchObject({ ok: true, account: "failed", accountError: "Stripe offline" });
    expect(rows.manager_application_records).toEqual([]);
    // The login (and so the resident's own threads) is still there; the response does not claim otherwise.
    expect(rows.portal_inbox_thread_records.map((row) => row.id)).toEqual(["thread-own"]);
    expect(result).toMatchObject({ removed: { conversations: 1 } });
  });
});

const fate = (db: unknown, extra: Record<string, unknown> = {}) =>
  decideResidentAccountFate(db as never, { actorUserId: MANAGER, managerUserId: MANAGER, email: EMAIL, residentUserId: RESIDENT, applicationId: "app-a", ...extra });

describe("M1: a direct relationship with PropLane keeps the login", () => {
  it.each(["active", "past_due", "trialing", "incomplete"])("a %s PropLane Number subscription keeps it", async (status) => {
    const { db } = database(baseSeed({ number_subscriptions: [{ owner_user_id: RESIDENT, status }] }));
    expect(await fate(db)).toMatchObject({ status: "keep", reason: "other_relationships", detail: "number_subscriptions" });
  });

  it.each(["canceled", "ended"])("a %s subscription does not", async (status) => {
    const { db } = database(baseSeed({ number_subscriptions: [{ owner_user_id: RESIDENT, status }] }));
    expect(await fate(db)).toEqual({ status: "delete", userId: RESIDENT });
  });

  it.each([
    ["included credit left", { included_remaining_cents: 300, purchased_credit_cents: 0 }],
    ["purchased credit left", { included_remaining_cents: 0, purchased_credit_cents: 500 }],
    ["a negative purchased balance", { included_remaining_cents: 0, purchased_credit_cents: -50 }],
  ])("a credit account with %s keeps it", async (_name, balance) => {
    const { db } = database(baseSeed({ number_credit_accounts: [{ owner_user_id: RESIDENT, ...balance }] }));
    expect(await fate(db)).toMatchObject({ status: "keep", detail: "number_credit_accounts" });
  });

  it("a zero-balance credit account does not", async () => {
    const { db } = database(baseSeed({ number_credit_accounts: [{ owner_user_id: RESIDENT, included_remaining_cents: 0, purchased_credit_cents: 0 }] }));
    expect(await fate(db)).toEqual({ status: "delete", userId: RESIDENT });
  });

  it("an agent number keeps it", async () => {
    const { db } = database(baseSeed({ resident_agent_numbers: [{ resident_user_id: RESIDENT }] }));
    expect(await fate(db)).toMatchObject({ status: "keep", detail: "resident_agent_numbers" });
  });

  it("any row in a resident-keyed manifest table with no manager column keeps it", async () => {
    const { db } = database(baseSeed({ rent_reporting_submissions: [{ resident_user_id: RESIDENT }] }));
    expect(await fate(db)).toMatchObject({ status: "keep", detail: "rent_reporting_submissions" });
  });

  it("a link to a person on someone else's application keeps it, as applicant or as helper", async () => {
    for (const link of [
      { application_id: "app-b", applicant_user_id: RESIDENT, helper_user_id: "friend" },
      { application_id: "app-b", applicant_user_id: "friend", helper_user_id: RESIDENT },
    ]) {
      const { db } = database(baseSeed({
        manager_application_records: [
          { id: "app-a", manager_user_id: MANAGER, resident_email: EMAIL },
          { id: "app-b", manager_user_id: OTHER_MANAGER, resident_email: "friend@example.com" },
        ],
        resident_account_links: [link],
      }));
      expect(await fate(db)).toMatchObject({ status: "keep", detail: "resident_account_links" });
    }
  });

  it("a link on the application being removed goes with it and does not keep the login", async () => {
    const { db } = database(baseSeed({
      resident_account_links: [{ application_id: "app-a", applicant_user_id: RESIDENT, helper_user_id: "friend" }],
    }));
    expect(await fate(db)).toEqual({ status: "delete", userId: RESIDENT });
  });

  it("is derived from the manifest: every resident-keyed table with no manager column is checked or explicitly handled", () => {
    const direct = residentDirectRelationshipSources().map((source) => source.table);
    expect(direct).toEqual(expect.arrayContaining(["resident_agent_numbers", "rent_reporting_submissions", "portal_resident_lease_upload_records"]));
    // Tables with their own rule (status / balance / which application) are not in the generic list.
    expect(direct).not.toContain("number_subscriptions");
    expect(direct).not.toContain("number_credit_accounts");
    expect(direct).not.toContain("resident_account_links");
    // Manager-keyed tables stay in the other-manager sweep, never the generic one.
    expect(residentRelationshipSources().map((source) => source.table)).not.toContain("resident_agent_numbers");
  });
});

describe("M2: resident-owned threads go only with the login", () => {
  it("kept login: the resident's threads survive and the preview does not count them", async () => {
    const { db, rows } = database(baseSeed({ number_subscriptions: [{ owner_user_id: RESIDENT, status: "active" }] }));
    const preview = await previewResidentApplicationRemoval(db as never, actor, input);
    expect(preview).toMatchObject({ ok: true, account: "kept", counts: { conversations: 1 }, total: 2 });
    const result = await removeResidentApplication(db as never, actor, input);
    expect(result).toMatchObject({ account: "kept", removed: { conversations: 1 }, total: 2 });
    expect(rows.portal_inbox_thread_records.map((row) => row.id)).toEqual(["thread-own"]);
  });

  it("deleted login: the preview counts the resident's threads too", async () => {
    const { db } = database(baseSeed());
    expect(await previewResidentApplicationRemoval(db as never, actor, input)).toMatchObject({
      account: "deleted",
      counts: { conversations: 2 },
      total: 3,
    });
  });
});

describe("LOW1: no account-existence oracle", () => {
  it("a manager sees the same answer for an address with no login as for one whose login is kept", async () => {
    const none = database(baseSeed({ profiles: [], profile_roles: [] }));
    const kept = database(baseSeed({ number_subscriptions: [{ owner_user_id: RESIDENT, status: "active" }] }));
    const a = await previewResidentApplicationRemoval(none.db as never, actor, input);
    const b = await previewResidentApplicationRemoval(kept.db as never, actor, input);
    expect(a).toMatchObject({ account: "kept" });
    expect(b).toMatchObject({ account: "kept" });
  });
});

describe("LOW2: only the workspace owner (or an admin) may delete the login", () => {
  const coManager = { userId: "co-manager", isAdmin: false };

  it("a co-manager's delete keeps the login and the resident's threads", async () => {
    const { db, rows } = database(baseSeed());
    expect(await fate(db, { actorUserId: "co-manager" })).toMatchObject({ status: "keep", reason: "not_owner" });
    expect(await previewResidentApplicationRemoval(db as never, coManager, input)).toMatchObject({ account: "kept", counts: { conversations: 1 } });
    const result = await removeResidentApplication(db as never, coManager, input);
    expect(result).toMatchObject({ ok: true, account: "kept" });
    expect(deleteOwnPortalAccount).not.toHaveBeenCalled();
    expect(rows.profiles.map((row) => row.id)).toContain(RESIDENT);
    expect(rows.portal_inbox_thread_records.map((row) => row.id)).toEqual(["thread-own"]);
  });

  it("an admin may delete it", async () => {
    const { db } = database(baseSeed());
    expect(await fate(db, { actorUserId: "admin-1", actorIsAdmin: true })).toEqual({ status: "delete", userId: RESIDENT });
    const result = await removeResidentApplication(db as never, { userId: "admin-1", isAdmin: true }, input);
    expect(result).toMatchObject({ account: "deleted" });
    expect(deleteOwnPortalAccount).toHaveBeenCalledWith(db, RESIDENT, "resident");
  });
});

describe("LOW3: relationship search gaps", () => {
  it("a row whose manager column is NULL counts as a relationship", async () => {
    const { db } = database(baseSeed({ portal_lease_pipeline_records: [{ id: "lease-x", manager_user_id: null, resident_email: EMAIL }] }));
    expect(await fate(db)).toMatchObject({ status: "keep", reason: "other_relationships", detail: "portal_lease_pipeline_records" });
  });

  it("the application being removed does not count even when its own manager stamp is NULL", async () => {
    const { db } = database(baseSeed({ manager_application_records: [{ id: "app-a", manager_user_id: null, resident_email: EMAIL }] }));
    expect(await fate(db)).toEqual({ status: "delete", userId: RESIDENT });
  });

  it("every manager column is checked, not just the first", async () => {
    // sms_outbox stamps a manager and an actor; the resident is the recipient.
    const { db } = database(baseSeed({ sms_outbox: [{ id: "sms", manager_user_id: MANAGER, actor_user_id: OTHER_MANAGER, recipient_user_id: RESIDENT }] }));
    expect(await fate(db)).toMatchObject({ status: "keep", detail: "sms_outbox" });
  });

  it("a table the check depends on that cannot be read keeps the account", async () => {
    const { db } = database(baseSeed(), ["number_subscriptions"]);
    expect(await fate(db)).toMatchObject({ status: "keep", reason: "unreadable" });
  });

  it("a manifest table this environment never migrated holds no rows and does not keep every account", async () => {
    const { db } = database(baseSeed(), ["rent_reporting_submissions", "portal_service_request_records", "resident_autopay_runs"]);
    expect(await fate(db)).toEqual({ status: "delete", userId: RESIDENT });
  });
});
