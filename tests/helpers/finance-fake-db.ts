/**
 * A tiny in-memory Supabase stand-in for the finance tests: tables are arrays of rows, and the query
 * builder supports the calls the finance code makes (select / insert / update / delete / upsert and the
 * eq, neq, is, in, gte, lte, order, range, limit filters, plus maybeSingle / single). It enforces the
 * unique journal key the real database has, so idempotency tests mean something. Embedded selects of
 * `gl_journal_lines(...)` attach the lines to their journal like PostgREST does.
 */
type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export type FinanceFakeDb = ReturnType<typeof createFinanceFakeDb>;

export function createFinanceFakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  let counter = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  const failures: { table: string; op: string; message: string }[] = [];

  const table = (name: string) => (tables[name] ??= []);

  function from(name: string) {
    const filters: Filter[] = [];
    let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: Row | Row[] | null = null;
    let selectCols = "*";
    let orderBy: { col: string; asc: boolean } | null = null;
    let rangeFrom = 0;
    let rangeTo = Number.POSITIVE_INFINITY;
    let wantsReturn = false;

    const matches = (row: Row) => filters.every((f) => f(row));

    function withRelations(row: Row): Row {
      if (name === "gl_journal_entries" && selectCols.includes("gl_journal_lines")) {
        return { ...row, gl_journal_lines: table("gl_journal_lines").filter((l) => l.journal_entry_id === row.id) };
      }
      return { ...row };
    }

    function run(): { data: Row[] | null; error: { message: string; code?: string } | null } {
      const injected = failures.find((f) => f.table === name && f.op === op);
      if (injected) return { data: null, error: { message: injected.message } };
      const rows = table(name);
      if (op === "insert" || op === "upsert") {
        const inserted: Row[] = [];
        for (const raw of Array.isArray(payload) ? payload : [payload as Row]) {
          const row: Row = { id: nextId(), ...(name === "gl_journal_entries" ? { is_reversal: false } : {}), ...raw };
          if (name === "gl_journal_entries") {
            const dup = rows.some(
              (r) =>
                r.manager_user_id === row.manager_user_id &&
                r.source_type === row.source_type &&
                r.source_id === row.source_id &&
                !r.is_reversal &&
                !row.is_reversal,
            );
            if (dup) return { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } };
          }
          if (name === "audit_log" && row.dedupe_key && rows.some((r) => r.dedupe_key === row.dedupe_key)) {
            return { data: null, error: { message: "duplicate key", code: "23505" } };
          }
          rows.push(row);
          inserted.push(row);
        }
        return { data: inserted.map(withRelations), error: null };
      }
      if (op === "update") {
        const hit = rows.filter(matches);
        for (const r of hit) Object.assign(r, payload as Row);
        return { data: hit.map(withRelations), error: null };
      }
      if (op === "delete") {
        const hit = rows.filter(matches);
        tables[name] = rows.filter((r) => !hit.includes(r));
        if (name === "gl_journal_entries") {
          const ids = new Set(hit.map((h) => h.id));
          tables.gl_journal_lines = table("gl_journal_lines").filter((l) => !ids.has(l.journal_entry_id));
        }
        return { data: hit.map(withRelations), error: null };
      }
      let out = rows.filter(matches);
      if (orderBy) {
        const { col, asc } = orderBy;
        out = [...out].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? (asc ? -1 : 1) : String(a[col] ?? "") > String(b[col] ?? "") ? (asc ? 1 : -1) : 0));
      }
      return { data: out.slice(rangeFrom, rangeTo + 1).map(withRelations), error: null };
    }

    const builder: Record<string, unknown> = {
      select(cols?: string) {
        if (op === "select") selectCols = cols ?? "*";
        else wantsReturn = true;
        return builder;
      },
      insert(p: Row | Row[]) { op = "insert"; payload = p; return builder; },
      upsert(p: Row | Row[]) { op = "upsert"; payload = p; return builder; },
      update(p: Row) { op = "update"; payload = p; return builder; },
      delete() { op = "delete"; return builder; },
      eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return builder; },
      neq(col: string, v: unknown) { filters.push((r) => r[col] !== v); return builder; },
      is(col: string, v: unknown) { filters.push((r) => (r[col] ?? null) === v); return builder; },
      not(col: string, op: string, v: unknown) {
        filters.push((r) => {
          const [base, path] = col.split("->");
          const value = path ? ((r[base!] as Record<string, unknown> | undefined) ?? {})[path] : r[base!];
          return op === "is" ? (value ?? null) !== v : value !== v;
        });
        return builder;
      },
      in(col: string, vs: unknown[]) { filters.push((r) => vs.includes(r[col])); return builder; },
      gte(col: string, v: string) { filters.push((r) => String(r[col] ?? "") >= v); return builder; },
      lte(col: string, v: string) { filters.push((r) => String(r[col] ?? "") <= v); return builder; },
      order(col: string, o?: { ascending?: boolean }) { orderBy = { col, asc: o?.ascending !== false }; return builder; },
      range(a: number, b: number) { rangeFrom = a; rangeTo = b; return builder; },
      limit(n: number) { rangeTo = rangeFrom + n - 1; return builder; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      single() {
        const r = run();
        const first = r.data?.[0];
        return Promise.resolve(first ? { data: first, error: null } : { data: null, error: r.error ?? { message: "no rows" } });
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        void wantsReturn;
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    from,
    tables,
    table,
    /** Make every `op` on `table` fail with `message` (for rollback tests). */
    failOn(tableName: string, op: "select" | "insert" | "update" | "delete" | "upsert", message = "injected failure") {
      failures.push({ table: tableName, op, message });
    },
    clearFailures() { failures.length = 0; },
  };
}
