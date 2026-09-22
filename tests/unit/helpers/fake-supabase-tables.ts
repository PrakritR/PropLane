/**
 * A minimal in-memory stand-in for a Supabase `SupabaseClient`, covering
 * exactly the PostgREST chain shapes the workspace-scoping surfaces under
 * test issue: `select/insert/update/delete/upsert` + `eq/neq/in/is/not/or`
 * filters + `order/limit` (no-ops here) + `single/maybeSingle`/thenable.
 *
 * Not a general Supabase mock — just enough surface for these tests to run
 * real filter logic (including the `col.in.(a,b),col.is.null` `.or()` shape
 * `applyWorkspaceRowScope` generates) against fixture rows, so a test proves
 * the actual query construction narrows correctly rather than only the pure
 * decision function.
 */

export type Row = Record<string, unknown>;

function matches(row: Row, col: string, val: unknown): boolean {
  return row[col] === val;
}

/** Just enough of PostgREST's `or()` grammar for `applyWorkspaceRowScope`'s two shapes. */
function buildOrMatcher(expr: string): (row: Row) => boolean {
  const clauses = expr.split(",");
  const matchers = clauses.map((clause) => {
    const inMatch = clause.match(/^(\w+)\.in\.\(([^)]*)\)$/);
    if (inMatch) {
      const [, col, list] = inMatch;
      const vals = list.split(",").map((v) => v.trim()).filter(Boolean);
      return (row: Row) => vals.includes(String(row[col]));
    }
    const isNullMatch = clause.match(/^(\w+)\.is\.null$/);
    if (isNullMatch) {
      const [, col] = isNullMatch;
      return (row: Row) => row[col] === null || row[col] === undefined;
    }
    throw new Error(`fake-supabase-tables: unhandled or() clause: ${clause}`);
  });
  return (row: Row) => matchers.some((m) => m(row));
}

let nextId = 1;

class FakeQuery implements PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  private working: Row[];
  private pendingInsert?: Row[];
  private pendingUpdate?: Row;
  private pendingUpsert?: { row: Row; onConflict?: string };
  private pendingDelete = false;

  constructor(
    private readonly master: Row[],
    initial: Row[],
  ) {
    this.working = initial;
  }

  select(): this {
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  ilike(): this {
    return this;
  }

  eq(col: string, val: unknown): this {
    this.working = this.working.filter((r) => matches(r, col, val));
    return this;
  }
  neq(col: string, val: unknown): this {
    this.working = this.working.filter((r) => !matches(r, col, val));
    return this;
  }
  in(col: string, vals: readonly unknown[]): this {
    const set = new Set(vals);
    this.working = this.working.filter((r) => set.has(r[col] as never));
    return this;
  }
  is(col: string, val: null): this {
    if (val === null) this.working = this.working.filter((r) => r[col] === null || r[col] === undefined);
    return this;
  }
  not(col: string, op: string, val: unknown): this {
    if (op === "is" && val === null) this.working = this.working.filter((r) => r[col] !== null && r[col] !== undefined);
    return this;
  }
  or(expr: string): this {
    this.working = this.working.filter(buildOrMatcher(expr));
    return this;
  }

  insert(row: Row | Row[]): this {
    const rows = Array.isArray(row) ? row : [row];
    this.pendingInsert = rows.map((r) => ({ id: r.id ?? `fake-${nextId++}`, ...r }));
    return this;
  }
  update(patch: Row): this {
    this.pendingUpdate = patch;
    return this;
  }
  upsert(row: Row, opts?: { onConflict?: string }): this {
    this.pendingUpsert = { row, onConflict: opts?.onConflict };
    return this;
  }
  delete(): this {
    this.pendingDelete = true;
    return this;
  }

  private commit(): Row[] {
    if (this.pendingInsert) {
      this.master.push(...this.pendingInsert);
      return this.pendingInsert;
    }
    if (this.pendingUpdate) {
      const ids = new Set(this.working.map((r) => r.id));
      const patched: Row[] = [];
      for (const r of this.master) {
        if (ids.has(r.id)) {
          Object.assign(r, this.pendingUpdate);
          patched.push(r);
        }
      }
      return patched;
    }
    if (this.pendingUpsert) {
      const keys = (this.pendingUpsert.onConflict ?? "id").split(",").map((k) => k.trim());
      const row = this.pendingUpsert.row;
      const existing = this.master.find((r) => keys.every((k) => r[k] === row[k]));
      if (existing) {
        Object.assign(existing, row);
        return [existing];
      }
      const created = { id: row.id ?? `fake-${nextId++}`, ...row };
      this.master.push(created);
      return [created];
    }
    if (this.pendingDelete) {
      const ids = new Set(this.working.map((r) => r.id));
      const removed = this.master.filter((r) => ids.has(r.id));
      const remaining = this.master.filter((r) => !ids.has(r.id));
      this.master.length = 0;
      this.master.push(...remaining);
      return removed;
    }
    return this.working;
  }

  async single(): Promise<{ data: Row | null; error: { message: string } | null }> {
    const result = this.commit();
    if (result.length !== 1) return { data: null, error: { message: "not found" } };
    return { data: result[0], error: null };
  }

  async maybeSingle(): Promise<{ data: Row | null; error: { message: string } | null }> {
    const result = this.commit();
    return { data: result[0] ?? null, error: null };
  }

  then<TResult1 = { data: Row[] | null; error: { message: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[] | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const result = this.commit();
    return Promise.resolve({ data: result, error: null }).then(onfulfilled, onrejected);
  }
}

/** A fake `db` with `.from(table)` reading/writing an in-memory table map. */
export function fakeSupabaseClient(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const master = tables[table] ?? (tables[table] = []);
      return new FakeQuery(master, [...master]);
    },
  };
}
