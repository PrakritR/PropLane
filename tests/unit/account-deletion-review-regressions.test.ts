import { removeResidentApplication } from "@/lib/auth/remove-resident-application";
import { describe, expect, it, vi } from "vitest";
import { deleteOwnPortalAccount, deleteAdminPortalAccount } from "@/lib/auth/delete-portal-account";
import { purgeResidentPortalData } from "@/lib/auth/purge-portal-account-data";

vi.mock("@/lib/auth/purge-orphaned-co-manager-links", () => ({ purgeCoManagerReferencesToUser: vi.fn() }));
vi.mock("@/lib/sms-relay.server", () => ({ closeRelayThreadsForUser: vi.fn(async () => undefined) }));

type Row = Record<string, unknown>;

/** Stateful PostgREST fixture: assertions inspect surviving rows, not query calls. */
function database(seed: Record<string, Row[]>) {
  const rows = structuredClone(seed);
  const db = {
    async rpc(_name: string, args: { p_table: string }) {
      // Financial behavior is exercised against PostgreSQL in the SQL suite.
      // These scope/retry fixtures only call preservation for empty tables.
      if ((rows[args.p_table] ?? []).length) throw new Error("Use the PostgreSQL financial fixture for populated financial tables");
      return { error: null, data: 0 };
    },
    from(table: string) {
      const predicates: ((row: Row) => boolean)[] = [];
      let action = "select";
      let offset = 0;
      let end = Infinity;
      let patch: Row = {};
      const read = (row: Row, column: string) => {
        const [key, nested] = column.split("->>");
        return nested ? (row[key] as Row | undefined)?.[nested] : row[key];
      };
      const query = {
        select() { return query; },
        order() { return query; },
        range(from: number, to: number) { offset = from; end = to + 1; return query; },
        delete() { action = "delete"; return query; },
        update(value: Row) { action = "update"; patch = value; return query; },
        eq(column: string, value: unknown) { predicates.push(row => read(row, column) === value); return query; },
        neq(column: string, value: unknown) { predicates.push(row => read(row, column) !== value); return query; },
        in(column: string, values: unknown[]) {
          predicates.push(row => values.includes(read(row, column))); return query;
        },
        ilike(column: string, value: string) {
          // These deletion queries must use literal emails, with wildcards escaped.
          const literal = value.replace(/\\([\\%_])/g, "$1").toLowerCase();
          predicates.push(row => String(read(row, column) ?? "").toLowerCase() === literal);
          return query;
        },
        filter(column: string, op: string, value: string) {
          return op === "ilike" ? query.ilike(column, value) : query.eq(column, value);
        },
        async maybeSingle() { return { data: (rows[table] ?? []).find(row => predicates.every(p => p(row))) ?? null, error: null }; },
        then(resolve: (result: { data: Row[]; error: null }) => void) {
          const matched = (rows[table] ?? []).filter(row => predicates.every(p => p(row))).slice(offset, end);
          if (action === "delete") rows[table] = (rows[table] ?? []).filter(row => !matched.includes(row));
          if (action === "update") for (const row of matched) Object.assign(row, patch);
          resolve({ data: matched, error: null });
        },
      };
      return query;
    },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ error: null }) }) },
    auth: { admin: { getUserById: vi.fn(async (id: string) => ({ data: { user: { id, email: rows.profiles?.find(row => row.id === id)?.email } }, error: null })), deleteUser: vi.fn(async (id: string) => {
      rows.profiles = rows.profiles.filter(row => row.id !== id);
      rows.profile_roles = rows.profile_roles.filter(row => row.user_id !== id);
      return { error: null };
    }) } },
  };
  return { db, rows };
}


/** Behavioral regressions first reproduced against Prakrit's unchanged baseline. */
describe("Prakrit account-deletion review: missing guarantees", () => {
  it("resident portal removal must preserve the same person's vendor login", async () => {
    const { db, rows } = database({
      profiles: [{ id: "dual", email: "dual@example.com", role: "resident" }],
      profile_roles: [{ user_id: "dual", role: "resident" }, { user_id: "dual", role: "vendor" }],
    });
    await deleteOwnPortalAccount(db as never, "dual", "resident");
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(rows.profile_roles).toEqual([{ user_id: "dual", role: "vendor" }]);
  });

  it("manager role removal must preserve resident conversations and shared preferences", async () => {
    const { db, rows } = database({
      profiles: [{ id: "dual", email: "dual@example.com", role: "manager" }],
      profile_roles: [{ user_id: "dual", role: "manager" }, { user_id: "dual", role: "resident" }],
      agent_sessions: [{ user_id: "dual", landlord_id: "dual", portal: "resident" }],
      notification_preferences: [{ user_id: "dual", preferences: "keep" }],
    });
    expect((await deleteOwnPortalAccount(db as never, "dual", "manager")).signedOut).toBe(false);
    expect.soft(rows.agent_sessions).toHaveLength(1);
    expect(rows.notification_preferences).toHaveLength(1);
  });

  it("resident cleanup must retain the shared admin support inbox", async () => {
    const { db, rows } = database({
      portal_inbox_thread_records: [{ id: "support", scope: "admin", row_data: { email: "resident@example.com" } }],
    });
    await purgeResidentPortalData(db as never, { email: "resident@example.com", userId: "resident" });
    expect(rows.portal_inbox_thread_records).toHaveLength(1);
  });

  it("failed document removal must not report successful account deletion", async () => {
    const { db } = database({
      profiles: [{ id: "owner", email: "owner@example.com", role: "manager" }],
      profile_roles: [{ user_id: "owner", role: "manager" }],
      manager_documents: [{ id: "doc", manager_user_id: "owner", storage_path: "manager/owner/lease.pdf" }],
    });
    vi.spyOn(db.storage, "from").mockReturnValue({
      list: async () => ({ data: [], error: null }),
      remove: async () => ({ error: { message: "Storage offline" } }),
    } as never);
    await expect(deleteOwnPortalAccount(db as never, "owner", "manager")).rejects.toThrow("Storage offline");
  });

  it("Auth failure must leave identity available for a deletion retry", async () => {
    const { db, rows } = database({
      profiles: [{ id: "owner", email: "owner@example.com", role: "manager" }],
      profile_roles: [{ user_id: "owner", role: "manager" }],
    });
    db.auth.admin.deleteUser.mockResolvedValueOnce({ error: { message: "Auth unavailable" } } as never);
    await expect(deleteAdminPortalAccount(db as never, "owner")).rejects.toThrow("Auth unavailable");
    expect.soft(rows.profiles).toHaveLength(1);
    expect(rows.profile_roles).toHaveLength(1);
  });

  it("resident cleanup must remove historical mixed-case email rows", async () => {
    const { db, rows } = database({
      portal_service_request_records: [{ id: "legacy", resident_email: "Resident@Example.com" }],
    });
    await purgeResidentPortalData(db as never, { email: "resident@example.com", userId: "resident" });
    expect(rows.portal_service_request_records).toEqual([]);
  });

  it("removing manager A's application must not purge manager B's tenancy", async () => {
    const { db, rows } = database({
      profiles: [{ id: "resident", email: "resident@example.com", role: "resident" }],
      profile_roles: [{ user_id: "resident", role: "resident" }],
      manager_application_records: [
        { id: "app-a", manager_user_id: "manager-a", resident_email: "resident@example.com" },
        { id: "app-b", manager_user_id: "manager-b", resident_email: "resident@example.com" },
      ],
      portal_lease_pipeline_records: [{ id: "lease-b", manager_user_id: "manager-b", resident_email: "resident@example.com" }],
    });
    await removeResidentApplication(db as never, { userId: "manager-a", isAdmin: false }, { email: "resident@example.com", applicationId: "app-a" });
    expect(rows.manager_application_records.map(row => row.id)).toEqual(["app-b"]);
    expect(rows.portal_lease_pipeline_records).toHaveLength(1);
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});
