/**
 * A small in-memory stand-in for the service-role Supabase client: each table is an array of
 * rows, and the query builder understands the handful of verbs the work-board code uses
 * (select / eq / neq / is / in / gt / not / order / limit / maybeSingle / single / insert / update /
 * upsert / delete, plus `row_data->>key` filters). It is NOT a SQL engine - just enough that a
 * test can seed rows, run the real code, and read back what was written.
 */
export type Row = Record<string, unknown>;

export type FakeDb = {
  tables: Record<string, Row[]>;
  from(table: string): FakeBuilder;
};

type Filter = (row: Row) => boolean;

function readPath(row: Row, column: string): unknown {
  const arrow = column.split("->>");
  if (arrow.length === 2) {
    const container = row[arrow[0]!] as Row | null | undefined;
    const value = container?.[arrow[1]!];
    return value === undefined || value === null ? null : String(value);
  }
  return row[column];
}

type FakeBuilder = PromiseLike<{ data: unknown; error: unknown; count?: number | null }> & Record<string, unknown>;

export function createFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  let counter = 0;

  function from(table: string): FakeBuilder {
    tables[table] ??= [];
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: Row | Row[] | null = null;
    let upsertConflict: string[] = [];
    let limitN: number | null = null;
    let orderBy: { column: string; ascending: boolean } | null = null;
    let wantsCount = false;
    let head = false;

    const matches = (row: Row) => filters.every((f) => f(row));

    function execute(): { data: unknown; error: unknown; count?: number | null } {
      const rows = tables[table]!;
      if (mode === "insert") {
        const items = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const created = items.map((item) => ({ id: `${table}-${++counter}`, created_at: new Date().toISOString(), ...item }));
        rows.push(...created);
        return { data: created, error: null };
      }
      if (mode === "upsert") {
        const item = payload as Row;
        const existing = rows.find((row) => upsertConflict.every((key) => row[key] === item[key]));
        if (existing) {
          Object.assign(existing, item);
          return { data: [existing], error: null };
        }
        const created = { id: `${table}-${++counter}`, ...item };
        rows.push(created);
        return { data: [created], error: null };
      }
      if (mode === "update") {
        const hit = rows.filter(matches);
        for (const row of hit) Object.assign(row, payload);
        return { data: hit, error: null };
      }
      if (mode === "delete") {
        const hit = rows.filter(matches);
        tables[table] = rows.filter((row) => !matches(row));
        return { data: hit, error: null };
      }
      let out = rows.filter(matches);
      if (orderBy) {
        const { column, ascending } = orderBy;
        out = [...out].sort((a, b) => String(readPath(a, column) ?? "").localeCompare(String(readPath(b, column) ?? "")) * (ascending ? 1 : -1));
      }
      const total = out.length;
      if (limitN !== null) out = out.slice(0, limitN);
      return { data: head ? null : out, error: null, count: wantsCount ? total : null };
    }

    const builder: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        wantsCount = opts?.count === "exact";
        head = opts?.head === true;
        return builder;
      },
      eq: (column: string, value: unknown) => (filters.push((row) => readPath(row, column) === value), builder),
      neq: (column: string, value: unknown) => (filters.push((row) => readPath(row, column) !== value), builder),
      is: (column: string, value: unknown) => (filters.push((row) => (readPath(row, column) ?? null) === value), builder),
      in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(readPath(row, column))), builder),
      gt: (column: string, value: unknown) => (filters.push((row) => String(readPath(row, column) ?? "") > String(value)), builder),
      not: (column: string, op: string, value: unknown) => {
        if (op === "is") filters.push((row) => (readPath(row, column) ?? null) !== value);
        return builder;
      },
      or: () => builder,
      order: (column: string, opts?: { ascending?: boolean }) => ((orderBy = { column, ascending: opts?.ascending !== false }), builder),
      limit: (n: number) => ((limitN = n), builder),
      insert: (row: Row | Row[]) => ((mode = "insert"), (payload = row), builder),
      update: (row: Row) => ((mode = "update"), (payload = row), builder),
      upsert: (row: Row, opts?: { onConflict?: string }) => (
        (mode = "upsert"),
        (payload = row),
        (upsertConflict = (opts?.onConflict ?? "id").split(",").map((s) => s.trim())),
        builder
      ),
      delete: () => ((mode = "delete"), builder),
      maybeSingle: async () => {
        const result = execute();
        const list = (result.data as Row[] | null) ?? [];
        return { data: list[0] ?? null, error: result.error };
      },
      single: async () => {
        const result = execute();
        const list = (result.data as Row[] | null) ?? [];
        return { data: list[0] ?? null, error: list[0] ? null : { message: "no rows" } };
      },
      then: (resolve: (value: ReturnType<typeof execute>) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve().then(execute).then(resolve, reject),
    };
    return builder as unknown as FakeBuilder;
  }

  return { tables, from };
}
