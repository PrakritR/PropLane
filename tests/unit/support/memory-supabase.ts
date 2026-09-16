/**
 * Minimal in-memory Supabase-PostgREST stub for unit tests. Supports the subset
 * of the query builder the SMS provisioning / relay / reminder code uses:
 * select/eq/neq/gt/lt/is/not/in/order/limit/maybeSingle, update().eq()...select(),
 * insert(), and upsert(rows, { onConflict, ignoreDuplicates }).select(). Filters
 * are applied faithfully so cross-tenant scoping is actually exercised.
 */

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export type MemoryDb = {
  from: (table: string) => Builder;
  /**
   * The two RPCs the work-identity code calls, behaving like their SQL:
   * `ensure_default_portal_workspace` creates-or-finds the owner's default
   * workspace; `claim_workspace_sms_provisioning` is the per-workspace
   * provisioning lock. Anything else is an error, like an unknown function.
   */
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  __tables: Record<string, Row[]>;
};

type Op =
  | { kind: "select" }
  | { kind: "update"; patch: Row }
  | { kind: "insert"; rows: Row[] }
  | { kind: "upsert"; rows: Row[]; onConflict: string; ignoreDuplicates: boolean }
  | { kind: "delete" };

interface Builder extends PromiseLike<{ data: Row[] | Row | null; error: null }> {
  select: (..._a: unknown[]) => Builder;
  eq: (col: string, val: unknown) => Builder;
  neq: (col: string, val: unknown) => Builder;
  /** Lexicographic compare - ISO timestamps sort correctly as strings. */
  gt: (col: string, val: unknown) => Builder;
  lt: (col: string, val: unknown) => Builder;
  is: (col: string, val: unknown) => Builder;
  not: (col: string, op: string, val: unknown) => Builder;
  in: (col: string, vals: unknown[]) => Builder;
  or: (..._a: unknown[]) => Builder;
  order: (col: string, opts?: { ascending?: boolean }) => Builder;
  limit: (n: number) => Builder;
  update: (patch: Row) => Builder;
  insert: (rows: Row | Row[]) => Builder;
  upsert: (rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => Builder;
  delete: () => Builder;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
}

export function createMemoryDb(seed: Record<string, Row[]> = {}): MemoryDb {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  const ensure = (t: string): Row[] => (tables[t] ??= []);

  function makeBuilder(table: string): Builder {
    ensure(table);
    const filters: Filter[] = [];
    let op: Op = { kind: "select" };
    let wantSelect = false;
    let single = false;
    let orderBy: { col: string; ascending: boolean } | null = null;
    let limitN: number | null = null;

    const applyFilters = (rows: Row[]) => rows.filter((r) => filters.every((f) => f(r)));

    function exec(): { data: Row[] | Row | null; error: null } {
      const rows = ensure(table);
      let out: Row[] = [];
      if (op.kind === "select") {
        out = applyFilters(rows);
        if (orderBy) {
          const { col, ascending } = orderBy;
          out = [...out].sort((a, b) => {
            const av = String(a[col] ?? "");
            const bv = String(b[col] ?? "");
            return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        if (limitN != null) out = out.slice(0, limitN);
      } else if (op.kind === "update") {
        const affected = applyFilters(rows);
        for (const r of affected) Object.assign(r, op.patch);
        out = affected;
      } else if (op.kind === "insert") {
        for (const r of op.rows) rows.push({ ...r });
        out = op.rows;
      } else if (op.kind === "upsert") {
        // Composite keys ("a,b") match Postgres' `on conflict (a, b)`.
        const keys = (op.onConflict || "id").split(",").map((k) => k.trim()).filter(Boolean);
        const inserted: Row[] = [];
        const upserted: Row[] = [];
        for (const r of op.rows) {
          const existing = rows.find((x) => keys.every((key) => String(x[key] ?? "") === String(r[key] ?? "")));
          if (existing) {
            if (!op.ignoreDuplicates) {
              Object.assign(existing, r);
              upserted.push(existing);
            }
          } else {
            const copy = { ...r };
            rows.push(copy);
            inserted.push(copy);
            upserted.push(copy);
          }
        }
        out = op.ignoreDuplicates ? inserted : upserted;
      } else if (op.kind === "delete") {
        const affected = applyFilters(rows);
        for (const r of affected) {
          const idx = rows.indexOf(r);
          if (idx >= 0) rows.splice(idx, 1);
        }
        out = affected;
      }
      if (single) return { data: out[0] ?? null, error: null };
      if (op.kind !== "select" && !wantSelect) return { data: null, error: null };
      return { data: out, error: null };
    }

    const builder = {
      select() {
        wantSelect = true;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => String(r[col] ?? "") === String(val));
        return builder;
      },
      neq(col: string, val: unknown) {
        filters.push((r) => String(r[col] ?? "") !== String(val));
        return builder;
      },
      is(col: string, val: unknown) {
        filters.push((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
        return builder;
      },
      not(col: string, _op: string, val: unknown) {
        filters.push((r) => (val === null ? !(r[col] === null || r[col] === undefined) : r[col] !== val));
        return builder;
      },
      gt(col: string, val: unknown) {
        filters.push((r) => String(r[col] ?? "") > String(val));
        return builder;
      },
      lt(col: string, val: unknown) {
        filters.push((r) => String(r[col] ?? "") < String(val));
        return builder;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals.map((v) => String(v)));
        filters.push((r) => set.has(String(r[col] ?? "")));
        return builder;
      },
      or() {
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderBy = { col, ascending: opts?.ascending !== false };
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      update(patch: Row) {
        op = { kind: "update", patch };
        return builder;
      },
      insert(rows: Row | Row[]) {
        op = { kind: "insert", rows: Array.isArray(rows) ? rows : [rows] };
        return builder;
      },
      upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        op = {
          kind: "upsert",
          rows: Array.isArray(rows) ? rows : [rows],
          onConflict: opts?.onConflict ?? "id",
          ignoreDuplicates: opts?.ignoreDuplicates ?? false,
        };
        return builder;
      },
      delete() {
        op = { kind: "delete" };
        return builder;
      },
      maybeSingle() {
        single = true;
        return Promise.resolve(exec() as { data: Row | null; error: null });
      },
      then<T>(
        resolve: (v: { data: Row[] | Row | null; error: null }) => T,
        reject?: (e: unknown) => T,
      ): Promise<T> {
        try {
          return Promise.resolve(resolve(exec()));
        } catch (e) {
          return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
        }
      },
    } as Builder;
    return builder;
  }

  let seq = 0;
  const rpc: MemoryDb["rpc"] = async (fn, args = {}) => {
    if (fn === "ensure_default_portal_workspace") {
      const owner = String(args.p_owner ?? "");
      const rows = ensure("portal_workspaces");
      const existing = rows.find((w) => w.owner_user_id === owner && w.is_default === true);
      if (existing) return { data: existing.id, error: null };
      const id = `ws-default-${owner}-${++seq}`;
      rows.push({ id, owner_user_id: owner, name: "My workspace", is_default: true, created_at: new Date(2026, 0, seq).toISOString() });
      return { data: id, error: null };
    }
    if (fn === "claim_workspace_sms_provisioning") {
      const row = ensure("manager_sms_numbers").find(
        (r) => r.workspace_id === args.p_workspace_id && ["pending_registration", "failed"].includes(String(r.provision_state)),
      );
      if (!row) return { data: false, error: null };
      row.provision_state = "provisioning";
      row.provision_request_id = args.p_request_id;
      row.attachment_state = "attaching";
      row.attempts = Number(row.attempts ?? 0) + 1;
      row.last_error = null;
      return { data: true, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${fn}` } };
  };
  return { from: makeBuilder, rpc, __tables: tables };
}
