/**
 * A job's vendor cost is expensed ONCE, across every rail that writes
 * `manager_expense_entries` against a work order: the completion's labor and materials lines and
 * `settle_vendor_invoice_payment`, which posts the paid vendor bill under the same
 * `source_work_order_id`. The guard reads all three and re-reads immediately before each insert, so
 * a row that lands while money is moving is still seen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gl = vi.hoisted(() => ({ postGlExpenseEntry: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/reports/gl-posting", () => gl);

import { createExpensesFromWorkOrder, readPostedWorkOrderExpenseLines } from "@/lib/work-order-expenses";

type Row = Record<string, unknown>;

const MANAGER = "mgr-1";
const JOB = "wo-1";

/**
 * `manager_expense_entries` only. `beforeEachRead` runs before every select, which is how a test
 * makes a row appear between the caller's read and the insert.
 */
function makeDb(rows: Row[], hooks: { readError?: string; beforeEachRead?: () => void } = {}) {
  const inserts: Row[] = [];
  let reads = 0;
  const from = (table: string) => {
    expect(table).toBe("manager_expense_entries");
    const filters: Array<[string, unknown]> = [];
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      },
      insert: (row: Row) => {
        const id = `exp-${inserts.length + 1}`;
        inserts.push(row);
        rows.push({ id, ...row });
        return {
          select: () => ({ single: async () => ({ data: { id }, error: null }) }),
        };
      },
      then: (resolve: (value: { data: Row[] | null; error: { message: string } | null }) => unknown) => {
        reads += 1;
        hooks.beforeEachRead?.();
        if (hooks.readError) return Promise.resolve({ data: null, error: { message: hooks.readError } }).then(resolve);
        return Promise.resolve({
          data: rows.filter((row) => filters.every(([column, value]) => row[column] === value)),
          error: null,
        }).then(resolve);
      },
    };
    return builder;
  };
  return { db: { from } as never, inserts, readCount: () => reads };
}

const invoiceRow = (over: Row = {}): Row => ({
  id: "exp-invoice",
  manager_user_id: MANAGER,
  source_work_order_id: JOB,
  source_vendor_invoice_id: "inv-1",
  category_code: "plumbing",
  ...over,
});

const completion = {
  workOrderId: JOB,
  category: "plumbing" as const,
  vendorCostCents: 15_200,
};

beforeEach(() => {
  gl.postGlExpenseEntry.mockClear();
});

describe("the vendor-invoice rail counts as the job's labor line", () => {
  it("reads a paid bill's expense as labor, whatever category the bill carried", async () => {
    const { db } = makeDb([invoiceRow()]);
    const read = await readPostedWorkOrderExpenseLines(db, MANAGER, JOB);
    expect(read).toEqual({ ok: true, posted: new Map([["labor", "exp-invoice"]]) });
  });

  it("still reads it as labor when the bill's own category happens to be materials", async () => {
    const { db } = makeDb([invoiceRow({ category_code: "materials" })]);
    const read = await readPostedWorkOrderExpenseLines(db, MANAGER, JOB);
    expect(read.ok && read.posted.get("labor")).toBe("exp-invoice");
    expect(read.ok && read.posted.get("materials")).toBeUndefined();
  });

  it("never posts labor a second time for a job whose invoice was already paid", async () => {
    const { db, inserts } = makeDb([invoiceRow()]);
    const ids = await createExpensesFromWorkOrder(db, MANAGER, completion);
    expect(inserts).toEqual([]);
    expect(ids).toEqual(["exp-invoice"]);
    expect(gl.postGlExpenseEntry).not.toHaveBeenCalled();
  });

  it("still posts the completion's materials line, which the invoice did not cover", async () => {
    const { db, inserts } = makeDb([invoiceRow()]);
    const ids = await createExpensesFromWorkOrder(db, MANAGER, { ...completion, materialsCostCents: 2_500 });
    expect(inserts.map((row) => row.category_code)).toEqual(["materials"]);
    expect(ids).toEqual(["exp-invoice", "exp-1"]);
  });
});

describe("the guard re-reads immediately before each insert", () => {
  it("skips a line another rail posted after the caller's read", async () => {
    const rows: Row[] = [];
    // The caller's read saw nothing; the row lands while the money was moving.
    const { db, inserts } = makeDb(rows, {
      beforeEachRead: () => {
        if (rows.length === 0) rows.push(invoiceRow());
      },
    });
    const ids = await createExpensesFromWorkOrder(db, MANAGER, completion, new Map());
    expect(inserts).toEqual([]);
    expect(ids).toEqual(["exp-invoice"]);
  });

  it("spends no extra read when the caller's answer already has the line", async () => {
    const { db, inserts, readCount } = makeDb([]);
    const ids = await createExpensesFromWorkOrder(db, MANAGER, completion, new Map([["labor", "exp-known"]]));
    expect(readCount()).toBe(0);
    expect(inserts).toEqual([]);
    expect(ids).toEqual(["exp-known"]);
  });

  it("posts once when nothing is posted anywhere", async () => {
    const { db, inserts } = makeDb([]);
    const ids = await createExpensesFromWorkOrder(db, MANAGER, completion, new Map());
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ category_code: "plumbing", amount_cents: 15_200, source_work_order_id: JOB });
    expect(ids).toEqual(["exp-1"]);
  });

  it("keeps the caller's answer when the refresh read fails, rather than blocking the posting", async () => {
    const { db, inserts } = makeDb([], { readError: "statement timeout" });
    const ids = await createExpensesFromWorkOrder(db, MANAGER, completion, new Map());
    expect(inserts).toHaveLength(1);
    expect(ids).toEqual(["exp-1"]);
  });

  it("refuses to post at all when it has to read for itself and that read fails", async () => {
    const { db, inserts } = makeDb([], { readError: "connection reset" });
    await expect(createExpensesFromWorkOrder(db, MANAGER, completion)).rejects.toThrow(/connection reset/);
    expect(inserts).toEqual([]);
  });
});
