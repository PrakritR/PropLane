/**
 * An in-memory service-role client for the admin read routes. Tables are
 * arrays of rows; the builder understands exactly the verbs the admin
 * aggregates use (select with head/count, eq, neq, in, not in/is, is, gte, lt,
 * ilike with real `%` / `_` patterns, a flat `col.eq.value,col2.eq.value2`
 * or() over eq/ilike/is clauses, order (several keys), limit, range,
 * maybeSingle) plus `auth.admin.getUserById`. A
 * column named `a->>b` reads `row.a[b]`, or the row's own `a->>b` key when a
 * test seeds it flat.
 */
export type Row = Record<string, unknown>;

/** `%` and `_` are wildcards unless escaped with a backslash; everything else is literal. */
function likePatternToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\" && index + 1 < pattern.length) {
      index += 1;
      source += pattern[index]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      continue;
    }
    if (character === "%") source += ".*";
    else if (character === "_") source += ".";
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

/** Clause boundaries in a PostgREST `or=` list: commas outside double quotes. */
function splitTopLevel(expr: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < expr.length; index += 1) {
    const character = expr[index]!;
    if (quoted && character === "\\" && index + 1 < expr.length) {
      current += character + expr[index + 1]!;
      index += 1;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (character === "," && !quoted) {
      out.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  out.push(current);
  return out.filter((clause) => clause.length > 0);
}

/** A double-quoted filter value, back to the string PostgREST would hand Postgres. */
function unquoteFilterValue(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  return value.slice(1, -1).replace(/\\(.)/g, "$1");
}

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
    const orders: { column: string; ascending: boolean }[] = [];
    let wantsCount = false;
    let head = false;

    const execute = () => {
      let out = rows.filter((row) => filters.every((f) => f(row)));
      const total = out.length;
      if (orders.length > 0) {
        out = [...out].sort((a, b) => {
          for (const { column, ascending } of orders) {
            const compared = String(read(a, column) ?? "").localeCompare(String(read(b, column) ?? ""));
            if (compared !== 0) return compared * (ascending ? 1 : -1);
          }
          return 0;
        });
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
      /**
       * A real ILIKE: `%` / `_` are wildcards, `\%` / `\_` are literals (how
       * `likeLiteral` escapes an address), and the match is case-insensitive.
       */
      ilike: (column: string, value: string) => {
        const pattern = likePatternToRegExp(value);
        filters.push((row) => pattern.test(String(read(row, column) ?? "")));
        return builder;
      },
      neq: (column: string, value: unknown) => (
        filters.push((row) => {
          const current = read(row, column);
          return current !== undefined && current !== null && current !== value;
        }),
        builder
      ),
      /**
       * `col.eq.value,col.ilike.pattern,col.is.null` — any clause matching keeps
       * the row. A value may be double-quoted, which is how PostgREST carries
       * one holding a comma or a parenthesis; the split respects those quotes
       * and the value is unescaped before matching.
       */
      or: (expr: string) => {
        const clauses = splitTopLevel(expr).map((clause) => {
          const column = clause.slice(0, clause.indexOf("."));
          const rest = clause.slice(column.length + 1);
          const op = rest.slice(0, rest.indexOf("."));
          return { column, op, value: unquoteFilterValue(rest.slice(op.length + 1)) };
        });
        filters.push((row) =>
          clauses.some(({ column, op, value }) => {
            const current = read(row, column);
            if (op === "ilike") return likePatternToRegExp(value).test(String(current ?? ""));
            if (op === "is") return (current ?? null) === (value === "null" ? null : value);
            return String(current ?? "") === value;
          }),
        );
        return builder;
      },
      order: (column: string, opts?: { ascending?: boolean }) => (
        orders.push({ column, ascending: opts?.ascending !== false }), builder
      ),
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
