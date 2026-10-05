import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

const url = process.env.PAYMENT_AUDIT_TEST_DATABASE_URL;
if (url && !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  throw new Error("Payment-claim proof requires a disposable local PostgreSQL database.");
}
const suite = url ? describe : describe.skip;
const db = new Pool({ connectionString: url, max: 8 });
const migration = readFileSync("supabase/migrations/20261004220000_vendor_invoice_stripe_checkout_claim.sql", "utf8");

async function invoiceFixture(opts: { workOrderId?: string; visitFee?: boolean } = {}) {
  const manager = randomUUID(), vendor = randomUUID(), invoice = randomUUID(), bill = randomUUID();
  const amount = 12345;
  await db.query("insert into auth.users(id) values($1),($2)", [manager, vendor]);
  if (opts.workOrderId) {
    await db.query("insert into public.portal_work_order_records(id,manager_user_id,vendor_user_id,row_data) values($1,$2,$3,$4)",
      [opts.workOrderId, manager, opts.visitFee ? randomUUID() : vendor, {}]);
  }
  const bidId = randomUUID();
  if (opts.visitFee) {
    await db.query("insert into public.work_order_bids(id,work_order_id,manager_user_id,vendor_user_id,estimate_visit_fee_cents,estimate_visit_done_at) values($1,$2,$3,$4,$5,now())",
      [bidId, opts.workOrderId, manager, vendor, amount]);
  }
  await db.query("insert into public.manager_bills(id,manager_user_id,vendor_id,work_order_id,description,amount_cents,status) values($1,$2,$3,$4,'Vendor invoice',$5,'approved')",
    [bill, manager, vendor, opts.workOrderId ?? null, amount]);
  await db.query("insert into public.vendor_invoices(id,manager_user_id,vendor_user_id,vendor_id,work_order_id,invoice_number,total_cents,status,bill_id,currency) values($1,$2,$3,$4,$5,$6,$7,'approved',$8,'usd')",
    [invoice, manager, vendor, vendor, opts.workOrderId ?? null, opts.visitFee ? `VISIT-${bidId}` : `INV-${invoice}`, amount, bill]);
  await db.query("update public.manager_bills set vendor_invoice_id=$1 where id=$2", [invoice, bill]);
  return { manager, vendor, invoice, bill, amount, workOrderId: opts.workOrderId };
}

suite("payment claim migration on local PostgreSQL", () => {
  beforeAll(async () => {
    // Luna's minimal schema fixture omits columns this exact migration writes.
    // On a fully migrated local database these statements are no-ops.
    await db.query(`
      alter table public.vendor_payouts add column if not exists failure_reason text;
      alter table public.vendor_payouts add column if not exists stripe_transfer_id text;
      alter table public.vendor_payouts add column if not exists refunded_gross_cents integer not null default 0;
      alter table public.vendor_invoices add column if not exists voided_at timestamptz;
      alter table public.portal_work_order_records add column if not exists updated_at timestamptz default now();
      alter table public.manager_expense_entries add column if not exists tax_deductible boolean default false;
      alter table public.manager_expense_entries add column if not exists source_vendor_invoice_id uuid references public.vendor_invoices(id);
      create table if not exists public.work_order_bids (
        id uuid primary key,work_order_id text not null,manager_user_id uuid not null,
        vendor_user_id uuid not null,estimate_visit_fee_cents integer not null default 0,
        estimate_visit_done_at timestamptz
      );
    `);
    await db.query(migration);
    await db.query(migration); // additive migration must be safe to re-apply
    // The disposable minimal fixture lacks production's client table grants;
    // expose the table here so the trigger, not a missing grant, is tested.
    await db.query("grant usage on schema public to authenticated; grant select,insert,update on public.manager_expense_entries to authenticated");
  });
  afterAll(async () => { await db.end(); });

  it("exposes new claims and releases only to service_role", async () => {
    for (const signature of [
      "claim_vendor_invoice_stripe_checkout(uuid,uuid,text)",
      "freeze_vendor_invoice_stripe_checkout_terms(uuid,uuid,text,jsonb)",
      "claim_vendor_invoice_payment(uuid,uuid,text)",
      "release_vendor_invoice_stripe_checkout(uuid,uuid,text)",
      "claim_work_order_vendor_payment(text,uuid,uuid,integer,text,jsonb)",
      "finish_work_order_vendor_checkout(text,uuid,text,text)",
      "release_work_order_vendor_checkout(text,uuid,text)",
      "release_work_order_balance_claim(text,uuid)",
      "mark_work_order_payment_paid(text,uuid,uuid,integer,text,text,jsonb)",
      "complete_work_order_record(text,uuid,jsonb)",
      "release_vendor_invoice_balance_claim(uuid,uuid)",
      "ensure_paid_work_order_expense(uuid,text,text,bigint,text,date,text,text,text,boolean)",
      "settle_vendor_invoice_payment(uuid,uuid,text,timestamp with time zone,text)",
      "proplane_balance_move(uuid,uuid,bigint,text,text,text)",
    ]) {
      for (const role of ["anon", "authenticated"]) {
        const result = await db.query("select has_function_privilege($1,$2,'execute') as allowed", [role, `public.${signature}`]);
        expect(result.rows[0].allowed, `${role} must not call ${signature}`).toBe(false);
      }
      const service = await db.query("select has_function_privilege('service_role',$1,'execute') as allowed", [`public.${signature}`]);
      expect(service.rows[0].allowed).toBe(true);
    }
  });

  it("arbitrates concurrent Stripe and balance claims for one standalone invoice", async () => {
    const f = await invoiceFixture();
    const attempts = await Promise.allSettled([
      db.query("select public.claim_vendor_invoice_stripe_checkout($1,$2,$3)", [f.invoice, f.manager, `attempt:card:${randomUUID()}`]),
      db.query("select public.claim_vendor_invoice_payment($1,$2,'balance')", [f.invoice, f.manager]),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const payout = await db.query("select count(*)::int as n from public.vendor_payouts where invoice_id=$1", [f.invoice]);
    expect(payout.rows[0].n).toBe(1);
  });

  it("keeps a claim bound to its session; wrong or stale release cannot free it", async () => {
    const f = await invoiceFixture();
    const attempt = `attempt:ach:${randomUUID()}`;
    expect((await db.query("select public.claim_vendor_invoice_stripe_checkout($1,$2,$3) as token", [f.invoice, f.manager, attempt])).rows[0].token).toBe(attempt);
    await db.query("update public.vendor_invoices set checkout_session_id='cs_real' where id=$1", [f.invoice]);
    expect((await db.query("select public.release_vendor_invoice_stripe_checkout($1,$2,'cs_wrong') as released", [f.invoice, f.manager])).rows[0].released).toBe(false);
    expect((await db.query("select public.release_vendor_invoice_stripe_checkout($1,$2,'cs_real') as released", [f.invoice, f.manager])).rows[0].released).toBe(true);
    expect((await db.query("select payment_claim,checkout_session_id from public.vendor_invoices where id=$1", [f.invoice])).rows[0]).toEqual({ payment_claim: null, checkout_session_id: null });
  });

  it("freezes the first exact invoice provider request across changed retry settings", async () => {
    const f = await invoiceFixture();
    const attempt = `attempt:ach:${randomUUID()}`;
    await db.query("select public.claim_vendor_invoice_stripe_checkout($1,$2,$3)",
      [f.invoice, f.manager, attempt]);
    const terms = { invoiceId: f.invoice, managerUserId: f.manager,
      vendorUserId: f.vendor, invoiceCents: f.amount,
      request: { idempotencyKey: `vendor-invoice:${f.invoice}:${attempt}`,
        paymentMethod: "ach", amountCents: f.amount, feePayer: "resident",
        destinationAccountId: null,
        metadata: { source_arbitration_v: "1", checkout_attempt: attempt,
          invoice_id: f.invoice, manager_user_id: f.manager,
          vendor_user_id: f.vendor, invoice_cents: String(f.amount),
          platform_fee_cents: "0" } } };
    const first = (await db.query(`select public.freeze_vendor_invoice_stripe_checkout_terms(
      $1,$2,$3,$4::jsonb) as terms`, [f.invoice, f.manager, attempt, JSON.stringify(terms)])).rows[0].terms;
    expect(first).toEqual(terms);
    const changed = structuredClone(terms);
    changed.request.metadata.platform_fee_cents = "300";
    const replay = (await db.query(`select public.freeze_vendor_invoice_stripe_checkout_terms(
      $1,$2,$3,$4::jsonb) as terms`, [f.invoice, f.manager, attempt, JSON.stringify(changed)])).rows[0].terms;
    expect(replay).toEqual(terms);
    await expect(db.query(`select public.freeze_vendor_invoice_stripe_checkout_terms(
      $1,$2,$3,$4::jsonb)`, [f.invoice, f.manager, `attempt:ach:${randomUUID()}`,
      JSON.stringify(terms)])).rejects.toThrow(/not current/);
  });

  it("replays a paid matching invoice claim for GL repair without another payout", async () => {
    const f = await invoiceFixture();
    await db.query("select public.claim_vendor_invoice_payment($1,$2,'balance')", [f.invoice, f.manager]);
    await db.query("update public.vendor_invoices set status='paid' where id=$1", [f.invoice]);
    await expect(db.query("select public.claim_vendor_invoice_payment($1,$2,'balance')", [f.invoice, f.manager])).resolves.toBeTruthy();
    expect((await db.query("select count(*)::int as n from public.vendor_payouts where invoice_id=$1", [f.invoice])).rows[0].n).toBe(1);
  });

  it("settles an invoice once and rejects a bill whose payee differs", async () => {
    const f = await invoiceFixture();
    await db.query("select public.claim_vendor_invoice_payment($1,$2,'balance')", [f.invoice, f.manager]);
    await db.query("update public.manager_bills set vendor_id='wrong-vendor' where id=$1", [f.bill]);
    await expect(db.query("select public.settle_vendor_invoice_payment($1,$2,'balance')", [f.invoice, f.manager])).rejects.toThrow(/Bill mismatch/);
    await db.query("update public.manager_bills set vendor_id=$1 where id=$2", [f.vendor, f.bill]);
    const a = await db.query("select public.settle_vendor_invoice_payment($1,$2,'balance') as bill", [f.invoice, f.manager]);
    const b = await db.query("select public.settle_vendor_invoice_payment($1,$2,'balance') as bill", [f.invoice, f.manager]);
    expect(a.rows[0].bill).toBe(b.rows[0].bill);
    expect((await db.query("select count(*)::int as n from public.manager_expense_entries where source_vendor_invoice_id=$1", [f.invoice])).rows[0].n).toBe(1);
  });

  it.each(["partially_refunded", "refunded"])("retains a %s invoice payout on paid-session replay", async (status) => {
    const f = await invoiceFixture();
    await db.query("select public.claim_vendor_invoice_payment($1,$2,'stripe')", [f.invoice, f.manager]);
    await db.query("select public.settle_vendor_invoice_payment($1,$2,'stripe')", [f.invoice, f.manager]);
    await db.query("update public.vendor_payouts set status=$1,refunded_gross_cents=$2 where invoice_id=$3", [status, status === "refunded" ? f.amount : 100, f.invoice]);
    await db.query("select public.settle_vendor_invoice_payment($1,$2,'stripe')", [f.invoice, f.manager]);
    expect((await db.query("select status,refunded_gross_cents from public.vendor_payouts where invoice_id=$1", [f.invoice])).rows[0])
      .toEqual({ status, refunded_gross_cents: status === "refunded" ? f.amount : 100 });
    expect((await db.query("select count(*)::int as n from public.manager_expense_entries where source_vendor_invoice_id=$1", [f.invoice])).rows[0].n).toBe(1);
  });

  it("creates exactly one paid labor and materials expense across concurrent webhook replays", async () => {
    const manager = randomUUID(), vendor = randomUUID(), service = `wo_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1),($2)", [manager, vendor]);
    await db.query("insert into public.portal_work_order_records(id,manager_user_id,vendor_user_id,row_data) values($1,$2,$3,'{}')", [service, manager, vendor]);
    const expense = (part: "labor" | "materials", amount: number) => db.query(
      "select public.ensure_paid_work_order_expense($1,$2,$3,$4,$5,current_date,null,null,$6,false) as id",
      [manager, service, part, amount, part === "labor" ? "maintenance" : "materials", part],
    );
    const [laborA,laborB,materialsA,materialsB] = await Promise.all([
      expense("labor", 700),expense("labor", 700),expense("materials", 300),expense("materials", 300),
    ]);
    expect(laborA.rows[0].id).toBe(laborB.rows[0].id);
    expect(materialsA.rows[0].id).toBe(materialsB.rows[0].id);
    expect((await db.query("select count(*)::int as n from public.manager_expense_entries where source_work_order_id=$1", [service])).rows[0].n).toBe(2);
    await expect(expense("labor", 701)).rejects.toThrow(/differs from settled service/);
  });

  it("blocks authenticated source-key forgery while preserving ordinary manual expense writes", async () => {
    const manager = randomUUID(), service = `wo_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1)", [manager]);
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      const insert = "insert into public.manager_expense_entries(manager_user_id,category_code,amount_cents,expense_date,source_work_order_id,source_work_order_component) values($1,'maintenance',500,current_date,$2,$3)";
      await expect(client.query(insert, [manager, service, "labor"])).rejects.toThrow(/server-owned/);
      await client.query("rollback");
      await client.query("begin");
      await client.query("set local role authenticated");
      await expect(client.query(insert, [manager, service, null])).resolves.toBeTruthy();
      await client.query("rollback");
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("keeps visit-fee payouts distinct from the service's own payout", async () => {
    const f = await invoiceFixture({ workOrderId: `wo_${randomUUID()}`, visitFee: true });
    await db.query("insert into public.vendor_payouts(manager_user_id,vendor_user_id,work_order_id,amount_cents,status) values($1,$2,$3,$4,'paid')", [f.manager, f.vendor, f.workOrderId, f.amount]);
    await db.query("select public.claim_vendor_invoice_payment($1,$2,'balance')", [f.invoice, f.manager]);
    const rows = await db.query("select work_order_id,invoice_id from public.vendor_payouts where manager_user_id=$1", [f.manager]);
    expect(rows.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ work_order_id: f.workOrderId, invoice_id: null }),
      expect.objectContaining({ work_order_id: null, invoice_id: f.invoice }),
    ]));
  });

  it("retries a failed service payout but blocks pending and paid ones", async () => {
    const manager = randomUUID(), vendor = randomUUID(), service = `wo_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1),($2)", [manager, vendor]);
    await db.query("insert into public.portal_work_order_records(id,manager_user_id,vendor_user_id,row_data) values($1,$2,$3,'{}')", [service, manager, vendor]);
    await db.query("insert into public.vendor_payouts(manager_user_id,vendor_user_id,work_order_id,amount_cents,status) values($1,$2,$3,500,'failed')", [manager, vendor, service]);
    await db.query("select public.claim_work_order_vendor_payment($1,$2,$3,500,'balance',null)", [service, manager, vendor]);
    expect((await db.query("select status from public.vendor_payouts where work_order_id=$1", [service])).rows[0].status).toBe("pending");
    await expect(db.query("select public.claim_work_order_vendor_payment($1,$2,$3,500,'ach',$4)", [service, manager, vendor, JSON.stringify({ sessionId: `attempt:${randomUUID()}` })])).rejects.toThrow();
  });

  it.each(["ach", "card"])("freezes a marked %s service Checkout request before Stripe and retains it on session binding", async (method) => {
    const manager = randomUUID(), vendor = randomUUID(), service = `wo_${randomUUID()}`;
    const attempt = `attempt:${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1),($2)", [manager, vendor]);
    await db.query("insert into public.portal_work_order_records(id,manager_user_id,vendor_user_id,row_data) values($1,$2,$3,'{}')",
      [service, manager, vendor]);
    const frozen = { managerUserId: manager, vendorUserId: vendor, invoiceCents: 500,
      platformFeeCents: 0,
      request: { idempotencyKey: `work-order:${service}:${attempt}`,
        amountCents: 500, destinationAccountId: null, paymentMethod: method,
        fixedFeeBreakdown: { residentAddedFeeCents: 20, totalCents: 520 },
        metadata: { source_arbitration_v: "1", checkout_attempt: attempt,
          work_order_id: service, manager_user_id: manager,
          vendor_user_id: vendor, invoice_cents: "500", platform_fee_cents: "0" } } };
    const pending = { sessionId: attempt, category: "plumbing", vendorCostCents: 500,
      providerTerms: frozen };
    await db.query("select public.claim_work_order_vendor_payment($1,$2,$3,500,$4,$5::jsonb)",
      [service, manager, vendor, method, JSON.stringify(pending)]);
    expect((await db.query("select public.finish_work_order_vendor_checkout($1,$2,$3,'cs_frozen') as bound",
      [service, manager, attempt])).rows[0].bound).toBe(true);
    const row = (await db.query("select row_data from public.portal_work_order_records where id=$1", [service])).rows[0].row_data;
    expect(row.pendingVendorPay.providerTerms).toEqual(frozen);
    expect(row.pendingVendorPay.sessionId).toBe("cs_frozen");
    await expect(db.query("select public.claim_work_order_vendor_payment($1,$2,$3,500,$4,$5::jsonb)",
      [service, manager, vendor, method, JSON.stringify({ ...pending,
        sessionId: `attempt:${randomUUID()}` })])).rejects.toThrow();
  });

  it("makes simultaneous same-key balance moves one debit, and never releases a funded claim", async () => {
    const manager = randomUUID(), vendor = randomUUID(), service = `wo_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1),($2)", [manager, vendor]);
    await db.query("insert into public.portal_work_order_records(id,manager_user_id,vendor_user_id,row_data) values($1,$2,$3,'{}')", [service, manager, vendor]);
    const payer = randomUUID(), payee = randomUUID();
    await db.query("insert into public.proplane_balance_accounts(id,owner_kind,owner_key,currency) values($1,'workspace',$2,'usd'),($3,'vendor',$4,'usd')", [payer, manager, payee, vendor]);
    await db.query("insert into public.proplane_balance_entries(account_id,amount_cents,kind,status,idempotency_key) values($1,500,'resident_payment','available',$2)", [payer, `fund:${service}`]);
    await db.query("select public.claim_work_order_vendor_payment($1,$2,$3,500,'balance',null)", [service, manager, vendor]);
    const blocker = await db.connect(), left = await db.connect(), right = await db.connect();
    let a: Awaited<ReturnType<typeof db.query>>, b: Awaited<ReturnType<typeof db.query>>;
    try {
      await blocker.query("begin");
      await blocker.query("select id from public.proplane_balance_accounts where id=any($1::uuid[]) order by id for update", [[payer,payee]]);
      const leftPid = (await left.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const rightPid = (await right.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const sql = "select * from public.proplane_balance_move($1,$2,500,'vendor_payment_out','vendor_payment_in',$3)";
      const first = left.query(sql,[payer,payee,`work-order:${service}`]);
      const second = right.query(sql,[payer,payee,`work-order:${service}`]);
      let bothWaiting = false;
      for (let i = 0; i < 100; i++) {
        const waits = await db.query("select count(*)::int as n from pg_stat_activity where pid=any($1::int[]) and wait_event_type='Lock'", [[leftPid,rightPid]]);
        if (waits.rows[0].n === 2) { bothWaiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(bothWaiting).toBe(true);
      await blocker.query("commit");
      [a,b] = await Promise.all([first,second]);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release(); left.release(); right.release();
    }
    expect(a.rows).toEqual(b.rows);
    expect((await db.query("select count(*)::int as n from public.proplane_balance_entries where idempotency_key=$1", [`work-order:${service}:out`])).rows[0].n).toBe(1);
    expect((await db.query("select public.release_work_order_balance_claim($1,$2) as released", [service,manager])).rows[0].released).toBe(false);
  });

  it("permits only the funded matching balance replay after the service row became paid", async () => {
    const manager = randomUUID(), vendor = randomUUID(), otherVendor = randomUUID(), service = `wo_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1),($2),($3)", [manager, vendor, otherVendor]);
    await db.query("insert into public.portal_work_order_records(id,manager_user_id,vendor_user_id,row_data) values($1,$2,$3,'{}')", [service, manager, vendor]);
    const payer = randomUUID(), payee = randomUUID();
    await db.query("insert into public.proplane_balance_accounts(id,owner_kind,owner_key,currency) values($1,'workspace',$2,'usd'),($3,'vendor',$4,'usd')", [payer, manager, payee, vendor]);
    await db.query("insert into public.proplane_balance_entries(account_id,amount_cents,kind,status,idempotency_key) values($1,500,'resident_payment','available',$2)", [payer, `fund:${service}`]);
    await db.query("select public.claim_work_order_vendor_payment($1,$2,$3,500,'balance',null)", [service, manager, vendor]);
    await db.query("select * from public.proplane_balance_move($1,$2,500,'vendor_payment_out','vendor_payment_in',$3)", [payer, payee, `work-order:${service}`]);
    await db.query("update public.portal_work_order_records set row_data=row_data || '{\"automationStatus\":\"paid\",\"paidAt\":\"2026-10-04T00:00:00Z\"}'::jsonb where id=$1", [service]);
    await expect(db.query("select public.claim_work_order_vendor_payment($1,$2,$3,500,'balance',null)", [service, manager, vendor])).resolves.toBeTruthy();
    await expect(db.query("select public.claim_work_order_vendor_payment($1,$2,$3,501,'balance',null)", [service, manager, vendor])).rejects.toThrow(/already paid/);
    await expect(db.query("select public.claim_work_order_vendor_payment($1,$2,$3,500,'balance',null)", [service, manager, otherVendor])).rejects.toThrow(/owner mismatch/);
    expect((await db.query("select count(*)::int as n from public.proplane_balance_entries where idempotency_key=$1", [`work-order:${service}:out`])).rows[0].n).toBe(1);
  });

  it("keeps a pending claim through a stale completion and a paid-row merge", async () => {
    const manager = randomUUID(), vendor = randomUUID(), service = `wo_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1),($2)", [manager, vendor]);
    await db.query("insert into public.portal_work_order_records(id,manager_user_id,vendor_user_id,row_data) values($1,$2,$3,$4)",
      [service, manager, vendor, { title: "Stored service", residentEmail: "real@example.com" }]);
    const payer = randomUUID(), payee = randomUUID();
    await db.query("insert into public.proplane_balance_accounts(id,owner_kind,owner_key,currency) values($1,'workspace',$2,'usd'),($3,'vendor',$4,'usd')", [payer, manager, payee, vendor]);
    await db.query("insert into public.proplane_balance_entries(account_id,amount_cents,kind,status,idempotency_key) values($1,500,'resident_payment','available',$2)", [payer, `fund:${service}`]);
    await db.query("select public.claim_work_order_vendor_payment($1,$2,$3,500,'balance',null)", [service, manager, vendor]);
    await expect(db.query("select public.complete_work_order_record($1,$2,$3)", [service, manager, { title: "Stale forged title" }]))
      .rejects.toThrow(/payment is already in progress/);
    await db.query("select * from public.proplane_balance_move($1,$2,500,'vendor_payment_out','vendor_payment_in',$3)", [payer,payee,`work-order:${service}`]);
    const paid = (await db.query("select public.mark_work_order_payment_paid($1,$2,$3,500,'balance',null,$4) as row", [
      service,manager,vendor,{ title: "Stale forged title", residentEmail: "forged@example.com", category: "maintenance", expenseEntryIds: [randomUUID()] },
    ])).rows[0].row;
    expect(paid.pendingBalancePay).toBe(`work-order:${service}`);
    expect(paid.title).toBe("Stored service");
    expect(paid.residentEmail).toBe("real@example.com");
    expect(paid.automationStatus).toBe("paid");
    await expect(db.query("select public.complete_work_order_record($1,$2,$3)", [service,manager,{ category: "maintenance" }]))
      .rejects.toThrow(/payment is already in progress or paid/);
  });
});
