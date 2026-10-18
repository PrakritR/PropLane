 
/**
 * A small stateful PostgREST fake for the one-number migration scripts and the simulated-texting suite:
 * select (columns, count/head), eq / neq / gt / gte / lt / lte / in / is / not, order, limit, range,
 * maybeSingle / single, insert, upsert (onConflict, ignoreDuplicates), update, delete, rpc handlers.
 *
 * Failure injection: `missingTables` answers like a migration that has not run (42P01);
 * `missingColumns` answers a read that names the column with 42703; `writeErrors` fails the n-th
 * write to a table. Every write is logged in `writes` so a dry run can be proven to write nothing.
 */
export type FakeRow = Record<string, unknown>;

type Options = {
  missingTables?: string[];
  missingColumns?: Record<string, string[]>;
  uniques?: Record<string, string[]>;
  rpc?: Record<string, (args: Record<string, unknown>, tables: Record<string, FakeRow[]>) => { data: unknown; error: null | { code?: string; message: string } }>;
  /** Cap rows returned per request, like PostgREST max-rows. */
  maxRows?: number;
  /** Reads of these tables fail with this code. */
  readErrors?: Record<string, string>;
};

export type FakeDb = {
  db: never;
  tables: Record<string, FakeRow[]>;
  writes: { table: string; op: "insert" | "upsert" | "update" | "delete"; count: number }[];
  reads: string[];
};

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
}

export function fakeMigrationDb(seed: Record<string, FakeRow[]> = {}, options: Options = {}): FakeDb {
  const tables: Record<string, FakeRow[]> = structuredClone(seed);
  const writes: FakeDb["writes"] = [];
  const reads: string[] = [];
  const missing = new Set(options.missingTables ?? []);

  const db = {
    rpc(name: string, args: Record<string, unknown> = {}) {
      const handler = options.rpc?.[name];
      if (!handler) return Promise.resolve({ data: null, error: { code: "42883", message: `function ${name} does not exist` } });
      return Promise.resolve(handler(args, tables));
    },
    from(table: string) {
      let mode: "select" | "insert" | "upsert" | "update" | "delete" = "select";
      const filters: ((row: FakeRow) => boolean)[] = [];
      let patch: FakeRow = {};
      let payload: FakeRow[] = [];
      let orderBy: { col: string; asc: boolean } | null = null;
      let limitN = Infinity;
      let rangeFrom = 0;
      let selectCols: string | null = null;
      let head = false;
      let wantCount = false;
      let single: "maybe" | "one" | null = null;
      let wantRows = false;
      let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};

      const execute = (): { data: unknown; error: null | { code?: string; message: string }; count?: number } => {
        if (missing.has(table)) return { data: null, error: { code: "42P01", message: `relation "${table}" does not exist` } };
        if (mode === "select") {
          const bad = (options.missingColumns?.[table] ?? []).find((c) => selectCols?.split(",").map((s) => s.trim()).includes(c) || filtersTouch(c));
          if (bad) return { data: null, error: { code: "42703", message: `column ${bad} does not exist` } };
          const code = options.readErrors?.[table];
          if (code) return { data: null, error: { code, message: "read failed" } };
          reads.push(table);
        }
        const list = (tables[table] ??= []);
        if (mode === "insert" || mode === "upsert") {
          const inserted: FakeRow[] = [];
          const uniqueCols = options.uniques?.[table];
          const conflictCols = mode === "upsert" ? (upsertOpts.onConflict ?? uniqueCols?.join(",") ?? "id").split(",").map((s) => s.trim()) : uniqueCols;
          for (const item of payload) {
            const existing = conflictCols ? list.find((row) => conflictCols.every((c) => row[c] === item[c])) : undefined;
            if (existing) {
              if (mode === "insert") return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
              if (!upsertOpts.ignoreDuplicates) Object.assign(existing, item);
              continue;
            }
            const row = { ...item };
            if (row.id === undefined && !conflictCols?.includes("id") && table !== "sms_consent") row.id = `${table}-${list.length + 1}-${Math.random().toString(36).slice(2, 6)}`;
            list.push(row);
            inserted.push(row);
          }
          writes.push({ table, op: mode, count: inserted.length });
          return { data: wantRows ? inserted.map((r) => ({ ...r })) : null, error: null };
        }
        const matched = list.filter((row) => filters.every((f) => f(row)));
        if (mode === "update") {
          for (const row of matched) Object.assign(row, patch);
          writes.push({ table, op: "update", count: matched.length });
          return { data: wantRows ? matched.map((r) => ({ ...r })) : null, error: null };
        }
        if (mode === "delete") {
          for (const row of matched) list.splice(list.indexOf(row), 1);
          writes.push({ table, op: "delete", count: matched.length });
          return { data: wantRows ? matched.map((r) => ({ ...r })) : null, error: null };
        }
        let out = matched;
        if (orderBy) out = [...out].sort((a, b) => (orderBy!.asc ? 1 : -1) * compare(a[orderBy!.col], b[orderBy!.col]));
        const total = out.length;
        out = out.slice(rangeFrom);
        const cap = Math.min(limitN, options.maxRows ?? Infinity);
        out = out.slice(0, cap);
        if (head) return { data: null, error: null, count: total };
        const cols = selectCols && selectCols !== "*" ? selectCols.split(",").map((s) => s.trim()) : null;
        const rows = out.map((row) => {
          if (!cols) return { ...row };
          const picked: FakeRow = {};
          for (const c of cols) picked[c] = row[c];
          return picked;
        });
        if (single === "maybe") return { data: rows[0] ?? null, error: null };
        if (single === "one") return rows.length ? { data: rows[0], error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
        return { data: rows, error: null, ...(wantCount ? { count: total } : {}) };
      };
      const touched: string[] = [];
      const filtersTouch = (c: string) => touched.includes(c);

      const builder: Record<string, unknown> = {
        select(cols?: string, opts?: { count?: string; head?: boolean }) {
          if (mode === "select") {
            selectCols = cols ?? "*";
            head = Boolean(opts?.head);
            wantCount = Boolean(opts?.count);
          } else wantRows = true;
          return builder;
        },
        eq(c: string, v: unknown) { touched.push(c); filters.push((r) => r[c] === v); return builder; },
        neq(c: string, v: unknown) { touched.push(c); filters.push((r) => r[c] !== v); return builder; },
        gt(c: string, v: unknown) { touched.push(c); filters.push((r) => compare(r[c], v) > 0); return builder; },
        gte(c: string, v: unknown) { touched.push(c); filters.push((r) => compare(r[c], v) >= 0); return builder; },
        lt(c: string, v: unknown) { touched.push(c); filters.push((r) => compare(r[c], v) < 0); return builder; },
        lte(c: string, v: unknown) { touched.push(c); filters.push((r) => compare(r[c], v) <= 0); return builder; },
        in(c: string, vs: unknown[]) { touched.push(c); filters.push((r) => vs.includes(r[c])); return builder; },
        is(c: string, v: unknown) { touched.push(c); filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return builder; },
        not(c: string, op: string, v: unknown) {
          touched.push(c);
          if (op === "is") filters.push((r) => (v === null ? r[c] != null : r[c] !== v));
          else if (op === "in") filters.push((r) => !String(v).replace(/[()]/g, "").split(",").includes(String(r[c])));
          else filters.push((r) => r[c] !== v);
          return builder;
        },
        order(c: string, o?: { ascending?: boolean }) { orderBy = { col: c, asc: o?.ascending !== false }; return builder; },
        limit(n: number) { limitN = n; return builder; },
        range(a: number, b: number) { rangeFrom = a; limitN = b - a + 1; return builder; },
        maybeSingle() { single = "maybe"; return Promise.resolve(execute()); },
        single() { single = "one"; return Promise.resolve(execute()); },
        insert(rows: FakeRow | FakeRow[]) { mode = "insert"; payload = Array.isArray(rows) ? rows : [rows]; return builder; },
        upsert(rows: FakeRow | FakeRow[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
          mode = "upsert"; payload = Array.isArray(rows) ? rows : [rows]; upsertOpts = opts ?? {}; return builder;
        },
        update(p: FakeRow) { mode = "update"; patch = p; return builder; },
        delete() { mode = "delete"; return builder; },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          try { return Promise.resolve(execute()).then(resolve, reject); } catch (e) { return Promise.reject(e).catch(reject as never); }
        },
      };
      return builder;
    },
  };
  return { db: db as never, tables, writes, reads };
}
