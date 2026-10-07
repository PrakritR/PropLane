type Row = Record<string, unknown>;

export type FakeDbWrite = { table: string; kind: "insert" | "update" | "upsert"; values: Row };

/**
 * A tiny in-memory PostgREST stand-in: eq / neq / in / or(ignored) /
 * maybeSingle over named tables, plus write capture (`writes`), a per-table
 * read counter (`reads`) so a test can prove a query is not run in a loop, and
 * `errors` to make a named table's reads fail.
 */
export function makeFakeDb(
  tables: Record<string, Row[]>,
  options: {
    writes?: FakeDbWrite[];
    reads?: Record<string, number>;
    errors?: Record<string, { message: string; code?: string }>;
  } = {},
) {
  const count = (table: string) => {
    if (options.reads) options.reads[table] = (options.reads[table] ?? 0) + 1;
  };
  const failure = (table: string) => options.errors?.[table] ?? null;
  return {
    from(table: string) {
      const filters: ((row: Row) => boolean)[] = [];
      const rows = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
      let pending: { kind: "insert" | "update" | "upsert"; values: Row } | null = null;
      const applyPending = () => {
        const write = pending;
        pending = null;
        if (!write) return;
        options.writes?.push({ table, kind: write.kind, values: write.values });
        const list = (tables[table] ??= []);
        if (write.kind === "update") {
          for (const row of rows()) Object.assign(row, write.values);
          return;
        }
        const at = list.findIndex((row) => row.id !== undefined && row.id === write.values.id);
        if (write.kind === "upsert" && at >= 0) list[at] = { ...list[at], ...write.values };
        else list.push(write.values);
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, value: unknown) => {
          filters.push((row) => row[col] === value);
          return builder;
        },
        neq: (col: string, value: unknown) => {
          filters.push((row) => row[col] !== value);
          return builder;
        },
        in: (col: string, values: unknown[]) => {
          filters.push((row) => values.includes(row[col]));
          return builder;
        },
        is: (col: string, value: unknown) => {
          filters.push((row) => (row[col] ?? null) === value);
          return builder;
        },
        ilike: (col: string, value: string) => {
          filters.push((row) => String(row[col] ?? "").toLowerCase() === value.toLowerCase());
          return builder;
        },
        gte: (col: string, value: unknown) => {
          filters.push((row) => String(row[col] ?? "") >= String(value));
          return builder;
        },
        lte: (col: string, value: unknown) => {
          filters.push((row) => String(row[col] ?? "") <= String(value));
          return builder;
        },
        not: (col: string, _op: string, value: unknown) => {
          filters.push((row) => (value === null ? row[col] != null : row[col] !== value));
          return builder;
        },
        or: () => builder,
        limit: () => builder,
        order: () => builder,
        // Writes are chainable like PostgREST's (`update(...).eq(...)`): the
        // change is applied when the builder is awaited, so filters added after
        // the call still decide which rows it hits.
        insert: (values: Row) => {
          pending = { kind: "insert", values };
          return builder;
        },
        update: (values: Row) => {
          pending = { kind: "update", values };
          return builder;
        },
        upsert: (values: Row) => {
          pending = { kind: "upsert", values };
          return builder;
        },
        maybeSingle: async () => {
          applyPending();
          count(table);
          const error = failure(table);
          return error ? { data: null, error } : { data: rows()[0] ?? null, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => {
          applyPending();
          count(table);
          const error = failure(table);
          return Promise.resolve(
            error ? { data: null, error, count: 0 } : { data: rows(), error: null, count: rows().length },
          ).then(resolve);
        },
      };
      return builder;
    },
  } as never;
}
