/** A tiny in-memory PostgREST stand-in: eq / neq / in / or(ignored) / maybeSingle over named tables. */
type Row = Record<string, unknown>;

export function makeFakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: ((row: Row) => boolean)[] = [];
      let rows = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
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
        or: () => builder,
        limit: () => builder,
        order: () => builder,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null, count: rows().length }).then(resolve),
      };
      return builder;
    },
  } as never;
}
