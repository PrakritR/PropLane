/**
 * A tiny in-memory service-role client for the PropLane Service tests: select / insert / update / delete /
 * upsert over arrays of rows with eq / in / is filters (including `jsonb->>key` columns), order,
 * maybeSingle, and the one rpc the Service tab calls. `failOn` makes a table's reads return a
 * Postgres-shaped error.
 */
export type Row = Record<string, unknown>;

/** A filtered column, which may address one key of a jsonb column the way PostgREST does. */
function column(row: Row, col: string): unknown {
  const arrow = col.split("->>");
  if (arrow.length !== 2) return row[col];
  const container = row[arrow[0]!] as Row | null | undefined;
  const value = container?.[arrow[1]!];
  return value === undefined || value === null ? null : String(value);
}

export type ServiceFakeDb = {
  tables: Record<string, Row[]>;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  failOn: Record<string, { code: string; message: string }>;
  /** Make the next insert into `table` fail. */
  failInsertOn: Set<string>;
  /** Make updates on `table` fail. */
  failUpdateOn: Set<string>;
  /** Make this rpc answer with an error, changing nothing (the real ones are single transactions). */
  failRpc: Set<string>;
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
    failUpdateOn: new Set(),
    failRpc: new Set(),
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
          const row = { id: newId(), ...(table === "manager_invite_links" ? { used_count: 0 } : {}), ...pendingInsert };
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
          if (db.failUpdateOn.has(table)) return { data: null, error: { code: "XX000", message: "update failed" } };
          const hit = matching();
          for (const r of hit) Object.assign(r, patch);
          return { data: hit.map((r) => ({ ...r })), error: null };
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
        eq: (col: string, value: unknown) => (filters.push((r) => column(r, col) === value), q),
        in: (col: string, values: unknown[]) => (filters.push((r) => values.includes(column(r, col))), q),
        is: (col: string, value: unknown) => (filters.push((r) => (value === null ? column(r, col) == null : column(r, col) === value)), q),
        not: (col: string, op: string, value: unknown) => (
          filters.push((r) => (op === "is" && value === null ? r[col] != null : r[col] !== value)), q
        ),
        lt: (col: string, value: number) => (filters.push((r) => Number(r[col]) < value), q),
        gt: (col: string, value: number) => (filters.push((r) => Number(r[col]) > value), q),
        neq: (col: string, value: unknown) => (filters.push((r) => r[col] !== value), q),
        like: (col: string, pattern: string) => {
          // Only the `prefix%` shape the service layer uses.
          const prefix = pattern.endsWith("%") ? pattern.slice(0, -1) : pattern;
          return (filters.push((r) => typeof r[col] === "string" && (pattern.endsWith("%") ? String(r[col]).startsWith(prefix) : r[col] === pattern)), q);
        },
        limit: () => q,
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
      if (db.failRpc.has(fn)) return { data: null, error: { code: "XX000", message: `${fn} failed` } };
      if (fn === "combine_portal_workspaces") {
        // The real one is a single transaction: it checks everything first, then changes only the house link and the
        // archive stamp.
        const workspaces = (db.tables.portal_workspaces ??= []);
        const sources = args.p_sources as string[];
        const target = workspaces.find((w) => w.id === args.p_target && w.owner_user_id === args.p_owner && !w.archived_at);
        const found = workspaces.filter((w) => sources.includes(String(w.id)) && w.owner_user_id === args.p_owner && !w.archived_at && w.is_service !== true);
        if (!target || sources.includes(String(args.p_target)) || found.length !== sources.length) {
          return { data: null, error: { code: "23514", message: "Every source must be an active, unmanaged workspace of this owner." } };
        }
        const moved: string[] = [];
        for (const h of (db.tables.manager_property_records ??= [])) {
          if (h.manager_user_id === args.p_owner && sources.includes(String(h.workspace_id))) {
            h.workspace_id = args.p_target;
            moved.push(String(h.id));
          }
        }
        const archived: string[] = [];
        for (const w of found) {
          if (w.is_default !== true) {
            w.archived_at = new Date().toISOString();
            archived.push(String(w.id));
          }
        }
        return { data: { moved, archived, kept: found.filter((w) => !w.archived_at).map((w) => String(w.id)) }, error: null };
      }
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
