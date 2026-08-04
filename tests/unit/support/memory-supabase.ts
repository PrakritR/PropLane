/**
 * Minimal in-memory Supabase-PostgREST stub for unit tests. Supports the subset
 * of the query builder the SMS provisioning / relay / reminder code uses:
 * select/eq/neq/is/not/in/order/limit/maybeSingle, update().eq()...select(),
 * insert(), and upsert(rows, { onConflict, ignoreDuplicates }).select(). Filters
 * are applied faithfully so cross-tenant scoping is actually exercised.
 */

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

/**
 * Column read that also understands PostgREST's `jsonb->>key` form, so a
 * compare-and-set guarded on a value inside `row_data` is really exercised
 * rather than silently matching everything. `->>` yields text in Postgres, and
 * a missing key yields NULL — both reproduced here.
 */
function readColumn(row: Row, col: string): unknown {
  const path = /^(\w+)->>(.+)$/.exec(col);
  if (!path) return row[col];
  const container = row[path[1]!];
  if (!container || typeof container !== "object") return undefined;
  const value = (container as Row)[path[2]!];
  return value === null || value === undefined ? value : String(value);
}

export type MemoryDb = {
  from: (table: string) => Builder;
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
        const key = op.onConflict || "id";
        const inserted: Row[] = [];
        const upserted: Row[] = [];
        for (const r of op.rows) {
          const existing = rows.find((x) => String(x[key] ?? "") === String(r[key] ?? ""));
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
        filters.push((r) => {
          const value = readColumn(r, col);
          // A NULL column never equals anything, matching Postgres.
          if (value === null || value === undefined) return false;
          return String(value) === String(val);
        });
        return builder;
      },
      neq(col: string, val: unknown) {
        filters.push((r) => String(readColumn(r, col) ?? "") !== String(val));
        return builder;
      },
      is(col: string, val: unknown) {
        filters.push((r) => {
          const value = readColumn(r, col);
          return val === null ? value === null || value === undefined : value === val;
        });
        return builder;
      },
      not(col: string, _op: string, val: unknown) {
        filters.push((r) => {
          const value = readColumn(r, col);
          return val === null ? !(value === null || value === undefined) : value !== val;
        });
        return builder;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals.map((v) => String(v)));
        filters.push((r) => set.has(String(readColumn(r, col) ?? "")));
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

  return { from: makeBuilder, __tables: tables };
}
