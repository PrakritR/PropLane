/**
 * What is guaranteed here: a job's vendor cost is expensed ONCE across the two completion rails
 * (Mark done and Approve + pay), and a job whose vendor invoice was already settled gets nothing
 * further from a completion — a paid bill is the vendor's whole cost for the job, so that one
 * `settle_vendor_invoice_payment` row closes both the labor and the materials line. The guard
 * re-reads immediately before each insert, so a row that lands while money is moving is still seen.
 *
 * The other direction, completion then invoice, is not guarded here: it rests on
 * `settle_vendor_invoice_payment`'s own `if expense_id is null` check, which is keyed per BILL
 * (`b.paid_expense_entry_id`, migration 20261003010000) rather than per work order.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gl = vi.hoisted(() => ({ postGlExpenseEntry: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/reports/gl-posting", () => gl);

import { createExpensesFromWorkOrder, readPostedWorkOrderExpenseLines } from "@/lib/work-order-expenses";

type Row = Record<string, unknown>;

const MANAGER = "mgr-1";
const JOB = "wo-1";

/**
 * `manager_expense_entries` plus the `vendor_invoices` lookup that tells the job's own bill from the
 * estimate-visit fee (both ride the same rail against the same work order). `beforeEachRead` runs
 * before every select on the expenses table, which is how a test makes a row appear between the
 * caller's read and the insert.
 */
function makeDb(
  rows: Row[],
  hooks: { readError?: string; beforeEachRead?: () => void; invoices?: Row[]; invoiceReadError?: string } = {},
) {
  const inserts: Row[] = [];
  let reads = 0;
  const invoices = hooks.invoices ?? [{ id: "inv-1", invoice_number: "INV-1001" }];
  const from = (table: string) => {
    expect(["manager_expense_entries", "vendor_invoices"]).toContain(table);
    const filters: Array<[string, unknown]> = [];
    let inFilter: { column: string; values: unknown[] } | null = null;
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        inFilter = { column, values };
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
        if (table === "vendor_invoices") {
          if (hooks.invoiceReadError) {
            return Promise.resolve({ data: null, error: { message: hooks.invoiceReadError } }).then(resolve);
          }
          const match = inFilter;
          return Promise.resolve({
            data: invoices.filter((row) => !match || match.values.includes(row[match.column])),
            error: null,
          }).then(resolve);
        }
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

describe("a settled vendor invoice is the job's whole vendor cost", () => {
  it("reads a paid bill's expense as the job's labor, whatever category the bill carried", async () => {
    const { db } = makeDb([invoiceRow()]);
    const read = await readPostedWorkOrderExpenseLines(db, MANAGER, JOB);
    expect(read.ok && read.posted.get("labor")).toBe("exp-invoice");
  });

  it("still closes both lines when the bill's own category happens to be materials", async () => {
    const { db } = makeDb([invoiceRow({ category_code: "materials" })]);
    const read = await readPostedWorkOrderExpenseLines(db, MANAGER, JOB);
    expect(read.ok && read.posted.get("labor")).toBe("exp-invoice");
    expect(read.ok && read.posted.get("materials")).toBe("exp-invoice");
  });

  it("never posts labor a second time for a job whose invoice was already paid", async () => {
    const { db, inserts } = makeDb([invoiceRow()]);
    const ids = await createExpensesFromWorkOrder(db, MANAGER, completion);
    expect(inserts).toEqual([]);
    expect(ids).toEqual(["exp-invoice"]);
    expect(gl.postGlExpenseEntry).not.toHaveBeenCalled();
  });

  it("posts no materials line either: the paid bill is the job's whole vendor cost", async () => {
    const { db, inserts } = makeDb([invoiceRow()]);
    const ids = await createExpensesFromWorkOrder(db, MANAGER, { ...completion, materialsCostCents: 4_000 });
    expect(inserts).toEqual([]);
    expect(ids).toEqual(["exp-invoice"]);
    expect(gl.postGlExpenseEntry).not.toHaveBeenCalled();
  });

  it("reads a settled invoice as closing both lines", async () => {
    const { db } = makeDb([invoiceRow()]);
    const read = await readPostedWorkOrderExpenseLines(db, MANAGER, JOB);
    expect(read.ok && [...read.posted]).toEqual([
      ["labor", "exp-invoice"],
      ["materials", "exp-invoice"],
    ]);
  });
});

/**
 * The estimate-visit fee is a SECOND invoice on the same service (`VISIT-<bid id>`), filed against
 * the same work order. A $50 visit fee is not the job's $500 labor: treating it as the whole bill
 * suppressed the accepted bid's expense entirely.
 */
describe("an estimate-visit fee invoice is not the job's bill", () => {
  const visitFeeInvoices: Row[] = [{ id: "inv-1", invoice_number: "VISIT-bid-1" }];

  it("closes neither line", async () => {
    const { db } = makeDb([invoiceRow()], { invoices: visitFeeInvoices });
    const read = await readPostedWorkOrderExpenseLines(db, MANAGER, JOB);
    expect(read.ok && [...read.posted]).toEqual([]);
  });

  it("still lets the job's own labor post after the fee settled", async () => {
    const { db, inserts } = makeDb([invoiceRow()], { invoices: visitFeeInvoices });
    const ids = await createExpensesFromWorkOrder(db, MANAGER, completion);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ amount_cents: 15_200, source_work_order_id: JOB });
    expect(ids).toEqual(["exp-1"]);
  });

  it("refuses to decide when the invoice lookup fails", async () => {
    const { db } = makeDb([invoiceRow()], { invoiceReadError: "statement timeout" });
    const read = await readPostedWorkOrderExpenseLines(db, MANAGER, JOB);
    expect(read.ok).toBe(false);
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

  // Marking a job done with no vendor or materials cost posts nothing, so it must not depend on
  // the ledger read it would only have used to decide what not to post: a failing read there
  // refused the whole completion (and its resident notice) over an expense it never had.
  it("reads nothing for a completion that carries no cost", async () => {
    const { db, inserts, readCount } = makeDb([], { readError: "connection reset" });
    const ids = await createExpensesFromWorkOrder(db, MANAGER, { workOrderId: JOB, category: "plumbing" });
    expect(readCount()).toBe(0);
    expect(inserts).toEqual([]);
    expect(ids).toEqual([]);
  });

  it("refuses to post at all when it has to read for itself and that read fails", async () => {
    const { db, inserts } = makeDb([], { readError: "connection reset" });
    await expect(createExpensesFromWorkOrder(db, MANAGER, completion)).rejects.toThrow(/connection reset/);
    expect(inserts).toEqual([]);
  });
});
