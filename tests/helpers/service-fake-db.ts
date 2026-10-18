/**
 * A tiny in-memory service-role client for the PropLane Service tests: select / insert / update / delete /
 * upsert over arrays of rows with eq / in / is filters, order, maybeSingle, and the one rpc the Service
 * tab calls. `failOn` makes a table's reads return a Postgres-shaped error.
 */
export type Row = Record<string, unknown>;

export type ServiceFakeDb = {
  tables: Record<string, Row[]>;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  failOn: Record<string, { code: string; message: string }>;
  /** Make the next insert into `table` fail. */
  failInsertOn: Set<string>;
  from(table: string): unknown;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { code?: string; message: string } | null }>;
};

let seq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

export function makeServiceFakeDb(initial: Record<string, Row[]> = {}): ServiceFakeDb {
  const db: ServiceFakeDb = {
    tables: Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v.map((r) => ({ ...r }))])),
    rpcCalls: [],
    failOn: {},
    failInsertOn: new Set(),
    from(table: string) {
      const rows = () => (db.tables[table] ??= []);
      const filters: Array<(r: Row) => boolean> = [];
      let mode: "select" | "update" | "delete" = "select";
      let patch: Row = {};
      let pendingInsert: Row | null = null;
      let pendingUpsert: { row: Row; ignoreDuplicates: boolean; onConflict: string } | null = null;
      let orderBy: { col: string } | null = null;
      let wantCount = false;
      const matching = () => rows().filter((r) => filters.every((f) => f(r)));
      const run = (): { data: unknown; error: { code?: string; message: string } | null } => {
        if (db.failOn[table] && mode === "select" && !pendingInsert) return { data: null, error: db.failOn[table]! };
        if (pendingInsert) {
          if (db.failInsertOn.has(table)) return { data: null, error: { code: "XX000", message: "insert failed" } };
          const row = { id: newId(), ...pendingInsert };
          rows().push(row);
          return { data: [row], error: null };
        }
        if (pendingUpsert) {
          const { row, ignoreDuplicates, onConflict } = pendingUpsert;
          const exists = rows().some((r) => r[onConflict] === row[onConflict]);
          if (!exists || !ignoreDuplicates) {
            if (exists) Object.assign(rows().find((r) => r[onConflict] === row[onConflict])!, row);
            else rows().push({ ...row });
          }
          return { data: null, error: null };
        }
        if (mode === "update") {
          for (const r of matching()) Object.assign(r, patch);
          return { data: null, error: null };
        }
        if (mode === "delete") {
          db.tables[table] = rows().filter((r) => !filters.every((f) => f(r)));
          return { data: null, error: null };
        }
        let out = matching();
        if (orderBy) out = [...out].sort((a, b) => String(a[orderBy!.col] ?? "").localeCompare(String(b[orderBy!.col] ?? "")));
        if (wantCount) return { data: null, count: out.length, error: null } as never;
        return { data: out.map((r) => ({ ...r })), error: null };
      };
      const q: Record<string, unknown> = {
        select: (_cols?: string, opts?: { count?: string }) => ((wantCount = opts?.count === "exact"), q),
        insert: (values: Row) => ((pendingInsert = values), q),
        upsert: (values: Row, opts: { onConflict: string; ignoreDuplicates?: boolean }) => (
          (pendingUpsert = { row: values, ignoreDuplicates: opts.ignoreDuplicates === true, onConflict: opts.onConflict }), q
        ),
        update: (values: Row) => ((mode = "update"), (patch = values), q),
        delete: () => ((mode = "delete"), q),
        eq: (col: string, value: unknown) => (filters.push((r) => r[col] === value), q),
        in: (col: string, values: unknown[]) => (filters.push((r) => values.includes(r[col])), q),
        is: (col: string, value: unknown) => (filters.push((r) => (value === null ? r[col] == null : r[col] === value)), q),
        order: (col: string) => ((orderBy = { col }), q),
        maybeSingle: async () => {
          const res = run();
          const first = Array.isArray(res.data) ? ((res.data as Row[])[0] ?? null) : null;
          return { data: res.error ? null : first, error: res.error };
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return q;
    },
    async rpc(fn, args) {
      db.rpcCalls.push({ fn, args });
      if (fn === "create_portal_service_workspace") {
        const settings = (db.tables.platform_service_settings ?? [])[0];
        if (!settings || settings.owner_user_id !== args.p_owner) {
          return { data: null, error: { code: "42501", message: "That account is not the PropLane service owner." } };
        }
        const owned = (db.tables.portal_workspaces ??= []).filter((w) => w.owner_user_id === args.p_owner);
        const row = {
          id: newId(),
          owner_user_id: args.p_owner,
          name: String(args.p_name).trim(),
          city: args.p_city ?? null,
          is_default: !owned.some((w) => w.is_default),
          is_service: true,
          created_at: new Date(Date.now() + seq).toISOString(),
        };
        db.tables.portal_workspaces.push(row);
        return { data: row.id, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    },
  };
  return db;
}
