import { vi } from "vitest";

type Row = Record<string, unknown>;

export type FakeDbOptions = {
  tables?: Record<string, Row[]>;
  /** Make every audit_log insert fail. */
  auditError?: { code?: string; message: string } | null;
  /** auth.admin.getUserById answer by id; absent id = purged. */
  authUsers?: Record<string, { banned_until?: string | null }>;
};

/**
 * A tiny in-memory stand-in for the service-role client: enough of the
 * query-builder surface (select / eq / in / maybeSingle / insert, awaitable)
 * for the "View as" rules. Inserts into audit_log are captured in `audit`;
 * a repeated dedupe_key answers 23505 like the unique index does.
 */
export function makeFakeDb(options: FakeDbOptions = {}) {
  const tables = options.tables ?? {};
  const audit: Row[] = [];
  const seenDedupe = new Set<string>();

  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    const q: Record<string, unknown> = {};
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    q.select = () => q;
    q.eq = (k: string, v: unknown) => {
      filters.push((r) => r[k] === v);
      return q;
    };
    q.in = (k: string, vs: unknown[]) => {
      filters.push((r) => vs.includes(r[k]));
      return q;
    };
    q.ilike = (k: string, v: string) => {
      filters.push((r) => String(r[k] ?? "").toLowerCase() === v.toLowerCase());
      return q;
    };
    q.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
    q.insert = async (row: Row) => {
      if (table !== "audit_log") return { error: null };
      if (options.auditError) return { error: options.auditError };
      const key = row.dedupe_key as string | null;
      if (key && seenDedupe.has(key)) return { error: { code: "23505", message: "duplicate" } };
      if (key) seenDedupe.add(key);
      audit.push(row);
      return { error: null };
    };
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null });
    return q;
  }

  const db = {
    from: vi.fn((table: string) => builder(table)),
    auth: {
      admin: {
        getUserById: vi.fn(async (id: string) => {
          const u = options.authUsers?.[id];
          return u ? { data: { user: { id, ...u } }, error: null } : { data: { user: null }, error: { message: "not found" } };
        }),
      },
    },
  };
  return { db, audit, tables };
}

export const UUID = {
  admin: "11111111-1111-4111-8111-111111111111",
  other: "22222222-2222-4222-8222-222222222222",
  manager: "33333333-3333-4333-8333-333333333333",
  resident: "44444444-4444-4444-8444-444444444444",
  vendor: "55555555-5555-4555-8555-555555555555",
  admin2: "66666666-6666-4666-8666-666666666666",
  testMember: "77777777-7777-4777-8777-777777777777",
};

export function standardTables(): Record<string, Row[]> {
  return {
    profiles: [
      { id: UUID.admin, email: "ops@example.com", full_name: "Ops Admin", role: "admin", application_approved: true },
      { id: UUID.admin2, email: "ops2@example.com", full_name: "Other Admin", role: "admin", application_approved: true },
      { id: UUID.manager, email: "mgr@example.com", full_name: "Mia Manager", role: "manager", application_approved: true },
      { id: UUID.resident, email: "res@example.com", full_name: "Rae Resident", role: "resident", application_approved: true },
      { id: UUID.vendor, email: "ven@example.com", full_name: "Vic Vendor", role: "vendor", application_approved: true },
      { id: UUID.testMember, email: "t@example.com", full_name: "Test Member", role: "manager", application_approved: true },
    ],
    profile_roles: [
      { user_id: UUID.admin, role: "admin" },
      { user_id: UUID.admin2, role: "admin" },
      { user_id: UUID.manager, role: "manager" },
      { user_id: UUID.resident, role: "resident" },
      { user_id: UUID.vendor, role: "vendor" },
      { user_id: UUID.testMember, role: "manager" },
    ],
    audit_log: [],
  };
}

export function standardAuthUsers(): Record<string, { banned_until?: string | null }> {
  return {
    [UUID.manager]: {},
    [UUID.resident]: {},
    [UUID.vendor]: {},
    [UUID.testMember]: {},
    [UUID.admin]: {},
    [UUID.admin2]: {},
  };
}
