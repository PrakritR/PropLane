/** A tiny in-memory stand-in for the slice of the Supabase builder the Plaid code uses. */
type Row = Record<string, unknown>;

export function createFakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    plaid_items: [],
    manager_bank_accounts: [],
    manager_bank_statements: [],
    manager_bank_statement_lines: [],
    ...seed,
  };
  let seq = 0;

  function builder(table: string) {
    let mode: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: Row | undefined;
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    const filters: ((r: Row) => boolean)[] = [];
    let limitN = Infinity;
    let single = false;
    let maybe = false;
    let orderBy: { col: string; asc: boolean } | null = null;

    const run = () => {
      const rows = tables[table]!;
      const decorate = (r: Row): Row => {
        if (table === "manager_bank_statement_lines") {
          return { ...r, manager_bank_statements: tables.manager_bank_statements!.find((s) => s.id === r.statement_id) ?? null };
        }
        return r;
      };
      let result: Row[] = [];
      if (mode === "insert") {
        const row = { id: `${table}-${++seq}`, ...payload! };
        rows.push(row);
        result = [row];
      } else if (mode === "upsert") {
        const key = upsertOpts.onConflict!;
        const dup = rows.find((r) => r[key] === payload![key]);
        if (dup) {
          if (!upsertOpts.ignoreDuplicates) Object.assign(dup, payload);
          result = upsertOpts.ignoreDuplicates ? [] : [dup];
        } else {
          const row = { id: `${table}-${++seq}`, ...payload! };
          rows.push(row);
          result = [row];
        }
      } else if (mode === "update") {
        result = rows.filter((r) => filters.every((f) => f(r)));
        for (const r of result) Object.assign(r, payload);
      } else if (mode === "delete") {
        result = rows.filter((r) => filters.every((f) => f(r)));
        tables[table] = rows.filter((r) => !result.includes(r));
      } else {
        result = rows.filter((r) => filters.every((f) => f(r))).map(decorate);
        if (orderBy) {
          const { col, asc } = orderBy;
          result = [...result].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
        }
      }
      result = result.slice(0, limitN);
      if (single) return { data: result[0] ?? null, error: result[0] ? null : { message: "no rows" } };
      if (maybe) return { data: result[0] ?? null, error: null };
      return { data: result, error: null };
    };

    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Row) => ((mode = "insert"), (payload = p), b),
      upsert: (p: Row, o: typeof upsertOpts) => ((mode = "upsert"), (payload = p), (upsertOpts = o), b),
      update: (p: Row) => ((mode = "update"), (payload = p), b),
      delete: () => ((mode = "delete"), b),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), b),
      lte: (c: string, v: string) => (filters.push((r) => String(r[c]) <= v), b),
      order: (col: string, o?: { ascending?: boolean }) => ((orderBy = { col, asc: o?.ascending !== false }), b),
      limit: (n: number) => ((limitN = n), b),
      or: () => b,
      single: () => ((single = true), b),
      maybeSingle: () => ((maybe = true), b),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    };
    return b;
  }

  return { tables, db: { from: (t: string) => builder(t) } as never };
}
