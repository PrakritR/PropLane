import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A small in-memory Supabase fake for the linked-form tests: select / insert / upsert / update / delete with
 * eq, neq, in, is, ilike, or, order, limit and maybeSingle. `.select()` after a write returns the affected rows.
 */
export type Row = Record<string, unknown>;
export type LinkedFormFakeDb = SupabaseClient & { tables: Record<string, Row[]> };

function matchOr(expression: string, row: Row): boolean {
  return expression.split(",").some((part) => {
    const match = /^([^.]+)\.(eq|is)\.(.*)$/.exec(part);
    if (!match) return false;
    const [, column, op, value] = match;
    const cell = row[column!];
    if (op === "is") return value === "null" ? cell === null || cell === undefined : false;
    return String(cell ?? "") === value;
  });
}

export function createLinkedFormFakeDb(seed: Record<string, Row[]> = {}): LinkedFormFakeDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  const table = (name: string) => (tables[name] ??= []);

  const from = (name: string) => {
    const predicates: Array<(row: Row) => boolean> = [];
    let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: Row | Row[] = {};
    let upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let max = Infinity;
    let orderBy: { column: string; ascending: boolean } | null = null;

    const execute = (): { data: Row[]; error: null | { message: string } } => {
      const rows = table(name);
      if (op === "insert" || op === "upsert") {
        const incoming = (Array.isArray(payload) ? payload : [payload]).map((row) => ({ ...row }));
        const inserted: Row[] = [];
        for (const row of incoming) {
          if (op === "upsert" && upsertOptions.onConflict) {
            const columns = upsertOptions.onConflict.split(",");
            const existing = rows.find((candidate) => columns.every((column) => candidate[column] === row[column]));
            if (existing) {
              if (!upsertOptions.ignoreDuplicates) Object.assign(existing, row);
              continue;
            }
          }
          const stored = { id: randomUUID(), created_at: new Date().toISOString(), ...row };
          rows.push(stored);
          inserted.push({ ...stored });
        }
        return { data: inserted, error: null };
      }
      let matched = rows.filter((row) => predicates.every((predicate) => predicate(row)));
      if (op === "update") {
        for (const row of matched) Object.assign(row, payload as Row);
        return { data: matched.map((row) => ({ ...row })), error: null };
      }
      if (op === "delete") {
        tables[name] = rows.filter((row) => !matched.includes(row));
        return { data: matched.map((row) => ({ ...row })), error: null };
      }
      if (orderBy) {
        const { column, ascending } = orderBy;
        matched = [...matched].sort((a, b) => {
          const result = String(a[column] ?? "").localeCompare(String(b[column] ?? ""));
          return ascending ? result : -result;
        });
      }
      return { data: matched.slice(0, max).map((row) => ({ ...row })), error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => (predicates.push((row) => row[column] === value), builder),
      neq: (column: string, value: unknown) => (predicates.push((row) => row[column] !== value), builder),
      in: (column: string, values: unknown[]) => (predicates.push((row) => values.includes(row[column])), builder),
      is: (column: string, value: unknown) =>
        (predicates.push((row) => (value === null ? row[column] === null || row[column] === undefined : row[column] === value)), builder),
      ilike: (column: string, pattern: string) =>
        (predicates.push((row) => String(row[column] ?? "").toLowerCase() === pattern.replace(/\\/g, "").toLowerCase()), builder),
      or: (expression: string) => (predicates.push((row) => matchOr(expression, row)), builder),
      order: (column: string, options?: { ascending?: boolean }) => ((orderBy = { column, ascending: options?.ascending !== false }), builder),
      limit: (count: number) => ((max = count), builder),
      insert: (rows: Row | Row[]) => ((op = "insert"), (payload = rows), builder),
      upsert: (rows: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) =>
        ((op = "upsert"), (payload = rows), (upsertOptions = options ?? {}), builder),
      update: (values: Row) => ((op = "update"), (payload = values), builder),
      delete: () => ((op = "delete"), builder),
      maybeSingle: async () => {
        const { data, error } = execute();
        return { data: data[0] ?? null, error };
      },
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(execute()).then(resolve, reject),
    };
    return builder;
  };

  return { tables, from } as unknown as LinkedFormFakeDb;
}
