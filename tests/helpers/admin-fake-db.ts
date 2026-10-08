/**
 * An in-memory service-role client for the admin read routes. Tables are
 * arrays of rows; the builder understands exactly the verbs the admin
 * aggregates use (select with head/count, eq, in, not in/is, is, gte, lt, ilike,
 * a flat `col.eq.value,col2.eq.value2` or(), order, limit, maybeSingle) plus
 * `auth.admin.getUserById`, and `range` for the paged id reads. A column named
 * `a->>b` reads `row.a[b]`, or the
 * row's own `a->>b` key when a test seeds it flat.
 */
export type Row = Record<string, unknown>;

function read(row: Row, column: string): unknown {
  if (column in row) return row[column];
  const arrow = column.split("->>");
  if (arrow.length === 2) {
    const container = row[arrow[0]!] as Row | null | undefined;
    const value = container?.[arrow[1]!];
    return value === undefined ? null : value;
  }
  return undefined;
}

export type AdminFakeDb = {
  tables: Record<string, Row[]>;
  /** Every table name a query touched, for "this route never reads X" assertions. */
  touched: Set<string>;
  authUsers: Record<string, { last_sign_in_at?: string | null; email_confirmed_at?: string | null }>;
  from(table: string): unknown;
  auth: { admin: { getUserById(id: string): Promise<{ data: { user: Row | null }; error: null }> } };
};

export function createAdminFakeDb(
  seed: Record<string, Row[]> = {},
  authUsers: AdminFakeDb["authUsers"] = {},
): AdminFakeDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  const touched = new Set<string>();

  function from(table: string) {
    touched.add(table);
    const rows = tables[table] ?? [];
    const filters: ((row: Row) => boolean)[] = [];
    let limitN: number | null = null;
    let pageWindow: { from: number; to: number } | null = null;
    let order: { column: string; ascending: boolean } | null = null;
    let wantsCount = false;
    let head = false;

    const execute = () => {
      let out = rows.filter((row) => filters.every((f) => f(row)));
      const total = out.length;
      if (order) {
        const { column, ascending } = order;
        out = [...out].sort(
          (a, b) => String(read(a, column) ?? "").localeCompare(String(read(b, column) ?? "")) * (ascending ? 1 : -1),
        );
      }
      if (limitN !== null) out = out.slice(0, limitN);
      if (pageWindow) out = out.slice(pageWindow.from, pageWindow.to + 1);
      return { data: head ? null : out, error: null, count: wantsCount ? total : null };
    };

    const builder: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        wantsCount = opts?.count === "exact";
        head = opts?.head === true;
        return builder;
      },
      eq: (column: string, value: unknown) => (filters.push((row) => read(row, column) === value), builder),
      in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(read(row, column))), builder),
      is: (column: string, value: unknown) => (filters.push((row) => (read(row, column) ?? null) === value), builder),
      not: (column: string, op: string, value: unknown) => {
        if (op === "is") filters.push((row) => (read(row, column) ?? null) !== value);
        if (op === "in") {
          const list = String(value).replace(/^\(|\)$/g, "").split(",");
          filters.push((row) => !list.includes(String(read(row, column))));
        }
        return builder;
      },
      gte: (column: string, value: unknown) => (filters.push((row) => String(read(row, column) ?? "") >= String(value)), builder),
      lt: (column: string, value: unknown) => (
        filters.push((row) => read(row, column) != null && String(read(row, column)) < String(value)), builder
      ),
      // The pattern arrives escaped (`likeLiteral`), so `\_` matches a literal underscore.
      ilike: (column: string, value: string) => {
        const literal = value.replace(/\\(.)/g, "$1").toLowerCase();
        filters.push((row) => String(read(row, column) ?? "").toLowerCase() === literal);
        return builder;
      },
      or: (expr: string) => {
        const clauses = expr.split(",").map((clause) => clause.split(".eq."));
        filters.push((row) => clauses.some(([col, val]) => String(read(row, col!) ?? "") === val));
        return builder;
      },
      order: (column: string, opts?: { ascending?: boolean }) => ((order = { column, ascending: opts?.ascending !== false }), builder),
      limit: (n: number) => ((limitN = n), builder),
      range: (from: number, to: number) => ((pageWindow = { from, to }), builder),
      maybeSingle: async () => {
        const result = execute();
        return { data: (result.data as Row[] | null)?.[0] ?? null, error: null };
      },
      then: (resolve: (value: ReturnType<typeof execute>) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve().then(execute).then(resolve, reject),
    };
    return builder;
  }

  return {
    tables,
    touched,
    authUsers,
    from,
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: { user: authUsers[id] ? ({ id, ...authUsers[id] } as Row) : null },
          error: null,
        }),
      },
    },
  };
}
