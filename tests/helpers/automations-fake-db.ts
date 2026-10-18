import { knowledgeFakeDb, type KnowledgeFakeDb, type Row } from "./knowledge-fake-db";

/**
 * The knowledge fake plus the three things the automations lean on: a unique
 * (workspace_id, idempotency_key) on the run ledger (23505 on a repeat), `count: exact, head: true`
 * selects, and `update ... select` chains. Everything else is the shared fake.
 */
export function automationsFakeDb(seed: Record<string, Row[]> = {}, options: { broken?: string[] } = {}): KnowledgeFakeDb {
  const base = knowledgeFakeDb(seed, options);
  const rawFrom = (base.db as unknown as { from: (t: string) => Record<string, unknown> }).from.bind(base.db);
  const db = {
    from(table: string) {
      const q = rawFrom(table) as Record<string, (...args: unknown[]) => unknown>;
      if (table === "workspace_automation_runs") {
        const insert = q.insert!.bind(q);
        q.insert = (value: unknown) => {
          const v = value as Row;
          const dup = (base.rows[table] ?? []).some(
            (r) => r.workspace_id === v.workspace_id && r.idempotency_key === v.idempotency_key,
          );
          if (dup) {
            const failed: Record<string, unknown> = {
              select: () => failed,
              maybeSingle: async () => ({ data: null, error: { code: "23505", message: "duplicate key" } }),
            };
            return failed;
          }
          return insert(value);
        };
      }
      const select = q.select!.bind(q);
      let head = false;
      q.select = (cols?: unknown, opts?: unknown) => {
        if ((opts as { head?: boolean } | undefined)?.head) head = true;
        return select(cols, opts);
      };
      const then = q.then!.bind(q);
      q.then = (resolve: (r: unknown) => void) =>
        then((result: unknown) => {
          const r = result as { data: unknown[] | null; error: unknown };
          resolve(head ? { ...r, count: Array.isArray(r.data) ? r.data.length : 0 } : r);
        });
      return q;
    },
  };
  return { ...base, db: db as never };
}
