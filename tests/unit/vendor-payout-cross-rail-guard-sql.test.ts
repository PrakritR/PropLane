import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * One job is never paid twice across rails. The (work order, invoice) unique index only arbitrates two
 * claims on the SAME invoice, so Approve + pay (invoice_id null) and the invoice rail used to be able to
 * both pay the same job. Migration 20261004160000 restores the arbitration in the database, where a
 * double click or two tabs cannot race past a read-then-insert. The real SQL runs here, on a minimal
 * schema that carries exactly the columns the migration reads.
 */
let db: PGlite;
const MANAGER = "00000000-0000-4000-8000-000000000001";
const VENDOR = "00000000-0000-4000-8000-000000000002";
const BID = "00000000-0000-4000-8000-0000000000b1";
const WO = "wo-1";

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table portal_work_order_records(id text primary key, manager_user_id uuid, vendor_user_id uuid);
    create table vendor_invoices(
      id uuid primary key default gen_random_uuid(), manager_user_id uuid, vendor_user_id uuid, work_order_id text,
      status text, payment_claim text, voided_at timestamptz, total_cents integer, bill_id uuid,
      estimate_visit_bid_id uuid, invoice_number text, updated_at timestamptz default now());
    create table vendor_payouts(
      id uuid primary key default gen_random_uuid(), manager_user_id uuid not null, vendor_user_id uuid not null,
      work_order_id text, invoice_id uuid, amount_cents integer not null, status text not null,
      created_at timestamptz default now(), updated_at timestamptz default now());
    -- The index 20261004140000 leaves in place: arbitrates only the SAME (work order, invoice).
    create unique index vendor_payouts_work_order_invoice_unique
      on vendor_payouts (work_order_id, coalesce(invoice_id, '00000000-0000-0000-0000-000000000000'::uuid))
      where work_order_id is not null;
  `);
  await db.exec(readFileSync("supabase/migrations/20261004160000_vendor_payout_cross_rail_guard.sql", "utf8"));
}, 30_000);
afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.exec("delete from vendor_payouts; delete from vendor_invoices; delete from portal_work_order_records;");
  await db.query("insert into portal_work_order_records values($1,$2,$3)", [WO, MANAGER, VENDOR]);
});

async function invoice(opts: { visitBid?: string | null; cents?: number } = {}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into vendor_invoices(manager_user_id,vendor_user_id,work_order_id,status,total_cents,bill_id,estimate_visit_bid_id)
     values($1,$2,$3,'approved',$4,gen_random_uuid(),$5) returning id`,
    [MANAGER, VENDOR, WO, opts.cents ?? 25_000, opts.visitBid ?? null],
  );
  return rows[0]!.id;
}
const claim = (invoiceId: string, rail = "offline") =>
  db.query("select claim_vendor_invoice_payment($1,$2,$3)", [invoiceId, MANAGER, rail]);
/** Approve + pay's own write: an invoice-less payout for the job. */
const approvePay = (status = "pending") =>
  db.query(
    "insert into vendor_payouts(manager_user_id,vendor_user_id,work_order_id,amount_cents,status) values($1,$2,$3,25000,$4)",
    [MANAGER, VENDOR, WO, status],
  );
const payoutCount = async () => Number((await db.query<{ n: string }>("select count(*)::text n from vendor_payouts")).rows[0]!.n);

describe("cross-rail double pay", () => {
  it("Approve + pay, then paying the job's own invoice: refused, no second payout", async () => {
    await approvePay();
    const inv = await invoice();
    await expect(claim(inv)).rejects.toThrow(/paid through Approve \+ pay/);
    expect(await payoutCount()).toBe(1);
    expect((await db.query<{ payment_claim: string | null }>("select payment_claim from vendor_invoices where id=$1", [inv])).rows[0]!.payment_claim).toBeNull();
  });

  it("a paid Approve + pay payout blocks the invoice rails just the same", async () => {
    await approvePay("paid");
    const inv = await invoice();
    for (const rail of ["offline", "balance", "stripe"]) await expect(claim(inv, rail)).rejects.toThrow(/pay the vendor twice/);
    expect(await payoutCount()).toBe(1);
  });

  it("paying the job's own invoice, then Approve + pay: refused by the database, whichever rail wrote first", async () => {
    const inv = await invoice();
    await claim(inv, "balance");
    await expect(approvePay()).rejects.toThrow(/pay the vendor twice/);
    expect(await payoutCount()).toBe(1);
  });

  it("a double click / second tab on the same rail is idempotent; on another rail it is refused", async () => {
    const inv = await invoice();
    await claim(inv, "balance");
    await claim(inv, "balance");
    await expect(claim(inv, "offline")).rejects.toThrow(/another source/);
    expect(await payoutCount()).toBe(1);
  });

  it("two Approve + pay writes (double click) leave exactly one payout", async () => {
    await approvePay();
    await expect(approvePay()).rejects.toThrow();
    expect(await payoutCount()).toBe(1);
  });

  it("the estimate-visit fee is a separate bill: it and the job are each payable once, in either order", async () => {
    const fee = await invoice({ visitBid: BID, cents: 5_000 });
    await claim(fee);
    await approvePay(); // job paid via Approve + pay after the fee
    expect(await payoutCount()).toBe(2);

    await db.exec("delete from vendor_payouts; update vendor_invoices set payment_claim=null");
    await approvePay(); // job first ...
    await claim(fee); // ... then the fee: not a double pay
    expect(await payoutCount()).toBe(2);
    await expect(approvePay()).rejects.toThrow(); // but the job still cannot be paid twice

    await db.exec("delete from vendor_payouts; update vendor_invoices set payment_claim=null");
    const job = await invoice();
    await claim(job);
    await claim(fee);
    expect(await payoutCount()).toBe(2);
    await expect(approvePay()).rejects.toThrow(/pay the vendor twice/);
  });

  it("a payout that moved no money does not block, and a pending payout can settle to paid", async () => {
    await approvePay("failed");
    const inv = await invoice();
    await claim(inv);
    await db.query("update vendor_payouts set status='paid' where invoice_id=$1", [inv]);
    expect(await payoutCount()).toBe(2);

    await db.exec("delete from vendor_payouts; update vendor_invoices set payment_claim=null");
    await approvePay();
    await db.query("update vendor_payouts set status='paid' where work_order_id=$1", [WO]);
    expect((await db.query<{ status: string }>("select status from vendor_payouts")).rows[0]!.status).toBe("paid");
  });

  it("re-driving a failed Approve + pay payout is refused once the job's invoice was paid", async () => {
    await approvePay("failed");
    const inv = await invoice();
    await claim(inv);
    await expect(db.query("update vendor_payouts set status='pending' where invoice_id is null and work_order_id=$1", [WO])).rejects.toThrow(/pay the vendor twice/);
  });
});

describe("one visit-fee invoice per bid", () => {
  it("the server-written marker is unique, so a renamed invoice cannot be filed twice for one bid", async () => {
    await invoice({ visitBid: BID, cents: 5_000 });
    await expect(invoice({ visitBid: BID, cents: 5_000 })).rejects.toThrow(/vendor_invoices_estimate_visit_bid_unique/);
    await invoice(); // ordinary invoices carry no marker and are unconstrained
    await invoice();
  });
});
