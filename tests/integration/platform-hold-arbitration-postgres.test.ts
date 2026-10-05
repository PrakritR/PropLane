import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.PAYMENT_AUDIT_TEST_DATABASE_URL;
if (url && !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  throw new Error("Hold arbitration proof requires a disposable local PostgreSQL database.");
}
const suite = url ? describe : describe.skip;
const db = new Pool({ connectionString: url, max: 8 });
const migration = readFileSync("supabase/migrations/20261004221000_platform_hold_source_arbitration.sql", "utf8");
const withdrawalMigration = readFileSync("supabase/migrations/20261004231000_classified_balance_withdrawal.sql", "utf8");

async function managerHold(amount = 100, gross = 105, existingOwner?: string, legacy = false) {
  const owner = existingOwner ?? randomUUID(), hold = randomUUID(), source = randomUUID();
  const charge = `ch_${source}`, intent = `pi_${source}`;
  await db.query("insert into auth.users(id) values($1) on conflict(id) do nothing", [owner]);
  await db.query("insert into public.profiles(id,stripe_connect_account_id) values($1,'acct_owner') on conflict(id) do nothing", [owner]);
  await db.query(`insert into public.platform_payment_holds
    (id,owner_user_id,owner_role,source,source_id,amount_cents,status,stripe_charge_id)
    values($1,$2,'manager','application_fee',$3,$4,$5,$6)`,
  [hold, owner, source, amount, legacy ? "held" : "classified_held", charge]);
  return { owner, hold, source, amount, gross, charge, intent };
}

async function verifySource(f: Awaited<ReturnType<typeof managerHold>>) {
  return db.query("select public.verify_platform_hold_source($1,$2,$3,$4,$5,$6,$7,$8,p_components=>$9::jsonb) as verified",
    [f.hold, f.owner, f.charge, f.intent, f.gross, f.amount, f.amount, "resident",
      JSON.stringify([{ source_id: f.source, kind: "application_fee", liability_class: "income",
        principal_cents: f.amount, recipient_net_cents: f.amount }])]);
}

suite("source-backed hold arbitration on local PostgreSQL", () => {
  beforeAll(async () => {
    // This disposable finance fixture predates account-preservation tables.
    // Install the real historical preservation functions before the additive
    // source migration so identity-detachment tests run against the actual RPC.
    const preservation = await db.query("select to_regclass('public.account_deleted_record_identities') as present");
    if (!preservation.rows[0].present) {
      await db.query("alter table auth.users add column if not exists email text");
      await db.query("create table if not exists public.audit_log(id uuid primary key,actor_user_id uuid not null)");
      for (const table of ["ledger_entries", "security_deposit_ledger", "manager_payment_plans",
        "portal_lease_pipeline_records"]) {
        await db.query(`create table if not exists public.${table}(id uuid primary key,row_data jsonb)`);
      }
      await db.query(readFileSync("supabase/migrations/20260907214100_preserve_resident_financial_history.sql", "utf8"));
      await db.query(readFileSync("supabase/migrations/20260907231000_account_recovery_financial_access_keys.sql", "utf8"));
    }
    // The source arbitration schema links creditor journals to the existing
    // GL table. Install its original migration in this isolated finance
    // fixture before applying the new additive migration.
    if (!(await db.query("select to_regclass('public.gl_journal_entries') as present")).rows[0].present) {
      await db.query(readFileSync("supabase/migrations/20260712090000_gl_journal.sql", "utf8"));
    }
    // The historical preservation fixture intentionally starts with a small
    // ledger shell. Give it the real ledger columns and existing fee/refund
    // indexes used by the production refund posting contract.
    await db.query(`alter table public.ledger_entries
      add column if not exists manager_user_id uuid,
      add column if not exists resident_user_id uuid,
      add column if not exists resident_email text,
      add column if not exists property_id text,
      add column if not exists unit_label text,
      add column if not exists lease_id text,
      add column if not exists entry_type text,
      add column if not exists category_code text,
      add column if not exists amount_cents bigint,
      add column if not exists due_date date,
      add column if not exists posted_date date,
      add column if not exists source_charge_id text,
      add column if not exists description text,
      add column if not exists stripe_checkout_session_id text,
      add column if not exists updated_at timestamptz not null default now()`);
    await db.query("alter table public.ledger_entries alter column id set default gen_random_uuid()");
    await db.query(readFileSync("supabase/migrations/20260710093000_ledger_entries_fee_tracking.sql", "utf8"));
    await db.query(readFileSync("supabase/migrations/20261003011500_distinct_ledger_refunds.sql", "utf8"));
    await db.query(`alter table public.vendor_payouts
      add column if not exists platform_fee_cents integer not null default 0;
      alter table public.vendor_payouts
      add column if not exists refunded_fee_cents integer not null default 0;
      alter table public.vendor_payouts
      add column if not exists stripe_charge_id text;`);
    await db.query(migration);
    await db.query(migration);
    await db.query(withdrawalMigration);
    await db.query(withdrawalMigration);
  });
  afterAll(async () => { await db.end(); });

  it("installs deleted-identity guards on every new retained source table", async () => {
    const tables = ["platform_hold_transfer_attempts", "platform_hold_refund_attempts",
      "platform_hold_refund_transfer_legs", "platform_source_consumption_legs"];
    const { rows } = await db.query(`select c.relname as table_name, t.tgname as trigger_name
      from pg_trigger t join pg_class c on c.oid=t.tgrelid
      where c.relname=any($1::text[]) and not t.tgisinternal
        and t.tgname='account_guard_deleted_financial_identity'`, [tables]);
    expect(rows.map((row) => row.table_name).sort()).toEqual(tables.sort());
  });

  it("preserves legacy held money without inventing source provenance", async () => {
    const f = await managerHold(100, 105, undefined, true);
    const legacy = (await db.query("select status,amount_cents,original_amount_cents,source_verified_at from public.platform_payment_holds where id=$1", [f.hold])).rows[0];
    expect(legacy).toMatchObject({ status: "held", amount_cents: 100,
      original_amount_cents: null, source_verified_at: null });
    await expect(db.query("select public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)",
      [f.hold, f.owner, `attempt:${randomUUID()}`, "acct_owner", f.charge]))
      .rejects.toThrow(/not verified/);
    expect((await verifySource(f)).rows[0].verified).toBe(true);
    expect((await verifySource(f)).rows[0].verified).toBe(false);
    await expect(db.query("select public.verify_platform_hold_source($1,$2,$3,$4,$5,$6,$7,$8,p_components=>$9::jsonb)",
      [f.hold, f.owner, f.charge, f.intent, f.gross, 99, 99, "resident",
        JSON.stringify([{ source_id: f.source, kind: "application_fee", liability_class: "income",
          principal_cents: 99, recipient_net_cents: 99 }])]))
      .rejects.toThrow(/mismatch/);
    await expect(db.query("select public.verify_platform_hold_source($1,$2,$3,$4,$5,$6,$7,$8,p_components=>$9::jsonb)",
      [f.hold, f.owner, f.charge, f.intent, f.gross, 100, 100, "vendor",
        JSON.stringify([{ source_id: f.source, kind: "application_fee", liability_class: "income",
          principal_cents: 100, recipient_net_cents: 100 }])]))
      .rejects.toThrow(/cannot be verified/);
    await expect(db.query("select public.verify_platform_hold_source($1,$2,$3,$4,$5,$6,$7,$8,p_components=>$9::jsonb)",
      [f.hold, f.owner, f.charge, f.intent, f.gross, 100, 100, null,
        JSON.stringify([{ source_id: f.source, kind: "application_fee", liability_class: "income",
          principal_cents: 100, recipient_net_cents: 100 }])]))
      .rejects.toThrow(/cannot be verified/);
  });

  it("keeps completed legacy balance replay but fences new unclassified debits after a classified mirror", async () => {
    const owner = randomUUID(), vendor = randomUUID(), source = randomUUID();
    const charge = `ch_${randomUUID()}`, intent = `pi_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1),($2)", [owner, vendor]);
    const payer = (await db.query("select public.proplane_balance_ensure_account('workspace',$1,'usd') as id", [owner])).rows[0].id;
    const payee = (await db.query("select public.proplane_balance_ensure_account('vendor',$1,'usd') as id", [vendor])).rows[0].id;
    await db.query(`insert into public.proplane_balance_entries(account_id,amount_cents,kind,status,idempotency_key)
      values($1,150,'resident_payment','available',$2)`, [payer, `legacy:${randomUUID()}`]);
    const oldRoot = `legacy-move:${randomUUID()}`;
    const moved = (await db.query("select * from public.proplane_balance_move($1,$2,20,'vendor_payment_out','vendor_payment_in',$3)",
      [payer, payee, oldRoot])).rows[0];
    await db.query(`insert into public.proplane_balance_entries(account_id,amount_cents,kind,status,idempotency_key)
      values($1,-10,'withdrawal','available',$2)`, [payer, `withdrawal:${randomUUID()}`]);
    const parts = JSON.stringify([{ source_id: source, kind: "rent", liability_class: "income",
      principal_cents: 100, recipient_net_cents: 100 }]);
    const credited = (await db.query(`select * from public.credit_verified_platform_income_mirror(
      $1,'household_charge',$2,$3,$4,100,100,100,'resident',$5::jsonb,null)`,
    [owner, `cs_${randomUUID()}`, charge, intent, parts])).rows[0];
    expect((await db.query("select status from public.platform_payment_holds where id=$1", [credited.hold_id])).rows[0].status)
      .toBe("classified_held");
    expect((await db.query("select * from public.proplane_balance_move($1,$2,20,'vendor_payment_out','vendor_payment_in',$3)",
      [payer, payee, oldRoot])).rows[0]).toEqual(moved);
    await expect(db.query("select * from public.proplane_balance_move($1,$2,20,'vendor_payment_out','vendor_payment_in',$3)",
      [payer, payee, `legacy-move:${randomUUID()}`])).rejects.toThrow(/legacy balance debit cannot spend classified source/);
    await expect(db.query(`insert into public.proplane_balance_entries(account_id,amount_cents,kind,status,idempotency_key)
      values($1,-10,'withdrawal','available',$2)`, [payer, `withdrawal:${randomUUID()}`]))
      .rejects.toThrow(/legacy balance debit cannot spend classified source/);
  });

  it("keeps legacy hold insert, refund and transfer writes compatible but unverified", async () => {
    const refunded = await managerHold(100, 105, undefined, true);
    const transferred = await managerHold(100, 105, undefined, true);
    const chargedLater = await managerHold(100, 105, undefined, true);
    await db.query(`update public.platform_payment_holds
      set status='refunded',updated_at=now() where id=$1 and status='held'`, [refunded.hold]);
    await db.query(`update public.platform_payment_holds
      set status='transferred',stripe_transfer_id=$2,updated_at=now()
      where id=$1 and status='held'`, [transferred.hold, `tr_${randomUUID()}`]);
    await db.query("update public.platform_payment_holds set stripe_charge_id=null where id=$1",
      [chargedLater.hold]);
    await db.query(`update public.platform_payment_holds
      set stripe_charge_id=$2,updated_at=now() where id=$1 and stripe_charge_id is null`,
    [chargedLater.hold, chargedLater.charge]);
    const { rows } = await db.query(`select id,status,amount_cents,source_verified_at,
      original_amount_cents from public.platform_payment_holds where id=any($1::uuid[])`,
    [[refunded.hold, transferred.hold, chargedLater.hold]]);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.id === refunded.hold)).toMatchObject({
      status: "refunded", amount_cents: 100, source_verified_at: null,
      original_amount_cents: null,
    });
    expect(rows.find((row) => row.id === transferred.hold)).toMatchObject({
      status: "transferred", amount_cents: 100, source_verified_at: null,
      original_amount_cents: null,
    });
    expect(rows.find((row) => row.id === chargedLater.hold)).toMatchObject({
      status: "held", amount_cents: 100, source_verified_at: null,
      original_amount_cents: null,
    });
  });

  it("cannot stamp verified provenance onto a row with missing essential source fields", async () => {
    const f = await managerHold();
    await expect(db.query(`update public.platform_payment_holds set source_verified_at=now(),
      original_amount_cents=100, source_principal_cents=100,
      source_charge_gross_cents=100, source_fee_payer='resident',
      source_allocation_mode='hold',source_components='[]'::jsonb where id=$1`, [f.hold]))
      .rejects.toThrow(/platform_hold_source_complete_check/);
    await expect(db.query(`update public.platform_payment_holds set source_verified_at=now(),
      original_amount_cents=100, source_principal_cents=100,
      source_charge_gross_cents=100, source_fee_payer='resident',
      source_allocation_mode='hold',source_payment_intent_id='',
      source_components='[{"source_id":"x"}]'::jsonb where id=$1`, [f.hold]))
      .rejects.toThrow(/platform_hold_source_complete_check/);
    expect((await db.query("select source_verified_at from public.platform_payment_holds where id=$1", [f.hold])).rows[0].source_verified_at)
      .toBeNull();
  });

  it("cannot verify Checkout and PI aliases as two entitlements for one captured PI", async () => {
    const checkout = await managerHold();
    const alias = await managerHold();
    await verifySource(checkout);
    await expect(verifySource({ ...alias, intent: checkout.intent }))
      .rejects.toThrow(/duplicate key/);
    const { rows } = await db.query(`select count(*)::int as n from public.platform_payment_holds
      where source_payment_intent_id=$1`, [checkout.intent]);
    expect(rows[0].n).toBe(1);
  });

  it("blocks refund-before-credit under the captured charge lock, then allows exact failed evidence", async () => {
    const owner = randomUUID(), source = randomUUID(), charge = `ch_${randomUUID()}`;
    const pi = `pi_${randomUUID()}`, refund = `re_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1)", [owner]);
    const components = JSON.stringify([{ source_id: source, kind: "application_fee",
      liability_class: "income", principal_cents: 100, recipient_net_cents: 100 }]);
    const event = await db.connect(), credit = await db.connect();
    const creditName = `refund-before-credit-${randomUUID()}`;
    try {
      await event.query("begin");
      await event.query("select public.record_platform_source_refund_evidence($1,$2,$3,50,'pending')",
        [refund, charge, pi]);
      await credit.query("select set_config('application_name',$1,false)", [creditName]);
      const waitingCredit = credit.query("select * from public.credit_verified_platform_hold($1,'manager','application_fee',$2,$3,$4,105,100,100,'resident',$5::jsonb)",
        [owner, `cs_${source}`, charge, pi, components]);
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i += 1) {
        const { rows } = await db.query("select wait_event_type from pg_stat_activity where application_name=$1", [creditName]);
        blocked = rows[0]?.wait_event_type === "Lock";
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await event.query("commit");
      await expect(waitingCredit).rejects.toThrow(/refund evidence/);
      expect((await db.query("select count(*)::int as n from public.platform_payment_holds where stripe_charge_id=$1", [charge])).rows[0].n).toBe(0);
      expect((await db.query("select public.record_platform_source_refund_evidence($1,$2,$3,50,'failed') as changed",
        [refund, charge, pi])).rows[0].changed).toBe(true);
      expect((await db.query("select public.record_platform_source_refund_evidence($1,$2,$3,50,'pending') as changed",
        [refund, charge, pi])).rows[0].changed).toBe(false);
      expect((await db.query("select * from public.credit_verified_platform_hold($1,'manager','application_fee',$2,$3,$4,105,100,100,'resident',$5::jsonb)",
        [owner, `cs_${source}`, charge, pi, components])).rows[0].credited).toBe(true);
      await expect(db.query("select public.record_platform_source_refund_evidence($1,$2,$3,50,'succeeded')",
        [refund, charge, pi])).rejects.toThrow(/terminal result/);
    } finally {
      await event.query("rollback").catch(() => undefined);
      event.release(); credit.release();
    }
  });

  it("blocks release if external refund evidence arrives after credit", async () => {
    const f = await managerHold();
    await verifySource(f);
    const refund = `re_${randomUUID()}`;
    const credit = await db.connect(), event = await db.connect();
    const eventName = `credit-before-refund-${randomUUID()}`;
    try {
      await credit.query("begin");
      await credit.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
        [`platform-source-charge:${f.charge}`]);
      await event.query("select set_config('application_name',$1,false)", [eventName]);
      const recording = event.query("select public.record_platform_source_refund_evidence($1,$2,$3,25,'pending')",
        [refund, f.charge, f.intent]);
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i += 1) {
        const { rows } = await db.query("select wait_event_type from pg_stat_activity where application_name=$1", [eventName]);
        blocked = rows[0]?.wait_event_type === "Lock";
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await credit.query("commit");
      await recording;
    } finally {
      await credit.query("rollback").catch(() => undefined);
      credit.release(); event.release();
    }
    await expect(db.query("select public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)",
      [f.hold, f.owner, `attempt:${randomUUID()}`, "acct_owner", f.charge]))
      .rejects.toThrow(/refund evidence/);
    expect((await db.query("select amount_cents,status from public.platform_payment_holds where id=$1", [f.hold])).rows[0])
      .toEqual({ amount_cents: 100, status: "classified_held" });
  });

  it("allows remaining release after a mapped succeeded partial refund, but blocks an unmapped extra", async () => {
    const f = await managerHold();
    await verifySource(f);
    const key = `refund:${randomUUID()}`, refund = `re_${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,25,$3,null)",
      [f.owner, key, f.hold]);
    await db.query("select public.record_platform_source_refund_evidence($1,$2,$3,25,'succeeded')",
      [refund, f.charge, f.intent]);
    expect((await db.query("select public.record_platform_source_refund_evidence($1,$2,$3,25,'pending') as changed",
      [refund, f.charge, f.intent])).rows[0].changed).toBe(false);
    await expect(db.query("select public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)",
      [f.hold, f.owner, `attempt:${randomUUID()}`, "acct_owner", f.charge]))
      .rejects.toThrow(/refund evidence/);
    await db.query("select public.finish_platform_money_refund($1,$2,25)", [key, refund]);
    const transfer = (await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).*",
      [f.hold, f.owner, `attempt:${randomUUID()}`, "acct_owner", f.charge])).rows[0];
    expect(transfer.amount_cents).toBe(75);
    await db.query("select public.record_platform_source_refund_evidence($1,$2,$3,5,'pending')",
      [`re_${randomUUID()}`, f.charge, f.intent]);
    await expect(db.query("select public.finish_platform_hold_transfer($1,$2,$3,$4)",
      [f.hold, f.owner, transfer.attempt_key, `tr_${randomUUID()}`]))
      .rejects.toThrow(/refund evidence/);
  });

  it("allocates a principal refund across residual source net and a real consumed shortfall", async () => {
    const f = await managerHold(100, 100);
    await verifySource(f);
    const account = (await db.query(`select public.proplane_balance_ensure_account(
      'workspace',$1,'usd') as id`, [f.owner])).rows[0].id;
    const walletDebit = (await db.query(`insert into public.proplane_balance_entries
      (account_id,amount_cents,kind,status,available_on,idempotency_key,stripe_object_id)
      values($1,-40,'withdrawal','available',now(),$2,$3) returning id`,
    [account, `withdraw:${randomUUID()}`, `tr_${randomUUID()}`])).rows[0].id;
    await db.query(`insert into public.platform_source_consumption_legs
      (hold_id,source_component_id,owner_user_id,kind,source_net_cents,
       wallet_debit_entry_id,provider_transfer_id,attempt_key,status)
      values($1,$2,$3,'owner_withdrawal',40,$4,$5,$6,'settled')`,
    [f.hold, f.source, f.owner, walletDebit, `tr_${randomUUID()}`, `source-use:${randomUUID()}`]);
    await db.query("update public.platform_payment_holds set amount_cents=60 where id=$1", [f.hold]);
    const key = `refund:${randomUUID()}`;
    const attempt = (await db.query(`select (public.reserve_platform_money_refund(
      $1,$2,100,$3,null)).*`, [f.owner, key, f.hold])).rows[0];
    expect(attempt).toMatchObject({ hold_debit_cents: 60, manager_debt_cents: 40,
      recipient_debit_components: [{ source_id: f.source, principal_cents: 100,
        recipient_debit_cents: 60, manager_debt_cents: 40 }] });
    const refund = `re_${randomUUID()}`;
    await db.query("select public.finish_platform_money_refund($1,$2,100)", [key, refund]);
    expect((await db.query("select status,amount_cents from public.platform_payment_holds where id=$1",
      [f.hold])).rows[0]).toEqual({ status: "refunded", amount_cents: 0 });
  });

  it("freezes each captured component remainder on a residual hold transfer", async () => {
    const f = await managerHold(100, 100);
    const income = randomUUID(), deposit = randomUUID();
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,100,100,100,'resident',p_components=>$5::jsonb)",
      [f.hold, f.owner, f.charge, f.intent, JSON.stringify([
        { source_id: income, kind: "rent", liability_class: "income",
          principal_cents: 80, recipient_net_cents: 80 },
        { source_id: deposit, kind: "security_deposit", liability_class: "deposit",
          principal_cents: 20, recipient_net_cents: 20 },
      ])]);
    const account = (await db.query("select public.proplane_balance_ensure_account('workspace',$1,'usd') as id",
      [f.owner])).rows[0].id;
    const debit = (await db.query(`insert into public.proplane_balance_entries
      (account_id,amount_cents,kind,status,idempotency_key)
      values($1,-40,'vendor_payment_out','available',$2) returning id`,
    [account, `source-out:${randomUUID()}`])).rows[0].id;
    const vendor = randomUUID();
    await db.query("insert into auth.users(id) values($1)", [vendor]);
    const vendorAccount = (await db.query("select public.proplane_balance_ensure_account('vendor',$1,'usd') as id",
      [vendor])).rows[0].id;
    const credit = (await db.query(`insert into public.proplane_balance_entries
      (account_id,amount_cents,kind,status,idempotency_key,related_entry_id)
      values($1,40,'vendor_payment_in','available',$2,$3) returning id`,
    [vendorAccount, `source-in:${randomUUID()}`, debit])).rows[0].id;
    await db.query(`insert into public.platform_source_consumption_legs
      (hold_id,source_component_id,owner_user_id,kind,source_net_cents,
       beneficiary_user_id,beneficiary_principal_cents,beneficiary_net_cents,vendor_fee_cents,
       wallet_debit_entry_id,wallet_credit_entry_id,attempt_key,status)
      values($1,$2,$3,'vendor_payment',40,$4,40,40,0,$5,$6,$7,'settled')`,
    [f.hold, income, f.owner, vendor, debit, credit, `consume:${randomUUID()}`]);
    await db.query("update public.platform_payment_holds set amount_cents=60 where id=$1", [f.hold]);
    const key = `release:${randomUUID()}`;
    const first = (await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).*",
      [f.hold, f.owner, key, "acct_owner", f.charge])).rows[0];
    expect(first.amount_cents).toBe(60);
    expect(first.component_breakdown).toEqual([
      { source_id: income, recipient_net_cents: 40 },
      { source_id: deposit, recipient_net_cents: 20 },
    ]);
    const replay = (await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).*",
      [f.hold, f.owner, key, "acct_owner", f.charge])).rows[0];
    expect(replay.id).toBe(first.id);
    expect(replay.component_breakdown).toEqual(first.component_breakdown);
  });

  it("reserves a bank withdrawal only from cleared captured components, never an offline credit", async () => {
    const f = await managerHold(105, 105);
    await verifySource(f);
    const account = (await db.query("select public.proplane_balance_ensure_account('workspace',$1,'usd') as id",
      [f.owner])).rows[0].id;
    await db.query(`insert into public.proplane_balance_entries
      (account_id,amount_cents,kind,status,available_on,idempotency_key,stripe_object_id,
       source_hold_id,source_component_id,source_liability_class)
      values($1,105,'resident_payment','available',now(),$2,$3,$4,$5,'income')`,
    [account, `credit:${f.source}`, f.charge, f.hold, f.source]);
    await db.query(`insert into public.proplane_balance_entries
      (account_id,amount_cents,kind,status,idempotency_key)
      values($1,1,'adjustment','available',$2)`, [account, `offline:${randomUUID()}`]);
    expect((await db.query("select public.proplane_balance_available_cents($1) as available",
      [account])).rows[0].available).toBe("106");
    const key = `withdrawal:${randomUUID()}`;
    await expect(db.query(`select (public.reserve_platform_classified_withdrawal(
      $1,$2,'workspace',106,$3,'acct_owner',$4::jsonb)).*`,
    [account, f.owner, key, JSON.stringify([{ hold_id: f.hold, source_id: f.source,
      source_net_cents: 106 }])])).rejects.toThrow(/already consumed|reserved/);
    const vector = JSON.stringify([{ hold_id: f.hold, source_id: f.source, source_net_cents: 105 }]);
    const first = (await db.query(`select (public.reserve_platform_classified_withdrawal(
      $1,$2,'workspace',105,$3,'acct_owner',$4::jsonb)).*`,
    [account, f.owner, key, vector])).rows[0];
    expect(first).toMatchObject({ amount_cents: "-105", kind: "withdrawal",
      stripe_object_id: null, withdrawal_provider_status: "reserved" });
    const retry = (await db.query(`select (public.reserve_platform_classified_withdrawal(
      $1,$2,'workspace',105,$3,'acct_owner',$4::jsonb)).*`,
    [account, f.owner, key, vector])).rows[0];
    expect(retry.id).toBe(first.id);
    await expect(db.query("select public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)",
      [f.hold, f.owner, `release:${randomUUID()}`, "acct_owner", f.charge]))
      .rejects.toThrow(/unresolved consumption/);
    const settled = (await db.query(`select (public.finish_platform_classified_withdrawal(
      $1,$2,'acct_owner','tr_exact_withdrawal')).*`, [first.id, key])).rows[0];
    expect(settled).toMatchObject({ stripe_object_id: "tr_exact_withdrawal",
      withdrawal_provider_status: "created" });
    expect((await db.query("select status,amount_cents from public.platform_payment_holds where id=$1",
      [f.hold])).rows[0]).toMatchObject({ amount_cents: 0 });
    expect((await db.query("select provider_transfer_id,status from public.platform_source_consumption_legs where wallet_debit_entry_id=$1",
      [first.id])).rows).toEqual([{ provider_transfer_id: "tr_exact_withdrawal", status: "settled" }]);
    await db.query("update public.proplane_balance_entries set withdrawal_provider_status='payout_created',withdrawal_payout_id='po_exact' where id=$1",
      [first.id]);
    const replay = (await db.query(`select (public.finish_platform_classified_withdrawal(
      $1,$2,'acct_owner','tr_exact_withdrawal')).*`, [first.id, key])).rows[0];
    expect(replay.withdrawal_payout_id).toBe("po_exact");
    expect((await db.query("select amount_cents from public.platform_payment_holds where id=$1",
      [f.hold])).rows[0].amount_cents).toBe(0);
  });

  it("reserves derived vendor earnings without consuming the manager source twice", async () => {
    const f = await managerHold(100, 100);
    await verifySource(f);
    const vendor = randomUUID();
    await db.query("insert into auth.users(id) values($1)", [vendor]);
    const managerAccount = (await db.query("select public.proplane_balance_ensure_account('workspace',$1,'usd') as id",
      [f.owner])).rows[0].id;
    const vendorAccount = (await db.query("select public.proplane_balance_ensure_account('vendor',$1,'usd') as id",
      [vendor])).rows[0].id;
    await db.query(`insert into public.proplane_balance_entries
      (account_id,amount_cents,kind,status,available_on,idempotency_key,stripe_object_id,
       source_hold_id,source_component_id,source_liability_class)
      values($1,100,'resident_payment','available',now(),$2,$3,$4,$5,'income')`,
    [managerAccount, `credit:${f.source}`, f.charge, f.hold, f.source]);
    const moved = (await db.query(`select * from public.platform_balance_move_from_sources(
      $1,$2,60,$3,$4::jsonb)`, [f.owner, vendorAccount, `vendor:${randomUUID()}`,
        JSON.stringify([{ hold_id: f.hold, source_id: f.source, source_net_cents: 60 }])])).rows[0];
    const second = await managerHold(40, 40, f.owner);
    await verifySource(second);
    await db.query(`insert into public.proplane_balance_entries
      (account_id,amount_cents,kind,status,available_on,idempotency_key,stripe_object_id,
       source_hold_id,source_component_id,source_liability_class)
      values($1,40,'resident_payment','available',now(),$2,$3,$4,$5,'income')`,
    [managerAccount, `credit:${second.source}`, second.charge, second.hold, second.source]);
    const movedSecond = (await db.query(`select * from public.platform_balance_move_from_sources(
      $1,$2,40,$3,$4::jsonb)`, [f.owner, vendorAccount, `vendor:${randomUUID()}`,
        JSON.stringify([{ hold_id: second.hold, source_id: second.source,
          source_net_cents: 40 }])])).rows[0];
    await expect(db.query(`insert into public.proplane_balance_entries
      (account_id,amount_cents,kind,status,idempotency_key)
      values($1,-10,'withdrawal','available',$2)`, [vendorAccount, `withdrawal:${randomUUID()}`]))
      .rejects.toThrow(/legacy balance debit cannot spend classified source/);
    const key = `withdrawal:${randomUUID()}`;
    const vector = JSON.stringify([{ vendor_credit_entry_id: moved.payee_entry_id,
      source_net_cents: 60 }]);
    const claim = (await db.query(`select (public.reserve_platform_classified_withdrawal(
      $1,$2,'vendor',60,$3,'acct_vendor',$4::jsonb)).*`,
    [vendorAccount, vendor, key, vector])).rows[0];
    expect(claim.source_spend_breakdown).toEqual(JSON.parse(vector));
    await expect(db.query(`select public.reserve_platform_classified_withdrawal(
      $1,$2,'vendor',1,$3,'acct_vendor',$4::jsonb)`, [vendorAccount, vendor,
      `withdrawal:${randomUUID()}`, JSON.stringify([{ vendor_credit_entry_id: moved.payee_entry_id,
        source_net_cents: 1 }])])).rejects.toThrow(/unavailable/);
    // The existing account-wide unknown-claim guard still blocks a second
    // withdrawal even from independent B until A is reconciled.
    await expect(db.query(`select public.reserve_platform_classified_withdrawal(
      $1,$2,'vendor',40,$3,'acct_vendor',$4::jsonb)`, [vendorAccount, vendor,
      `withdrawal:${randomUUID()}`, JSON.stringify([{ vendor_credit_entry_id: movedSecond.payee_entry_id,
        source_net_cents: 40 }])])).rejects.toThrow(/withdrawal_claim_unique/);
    await db.query("select public.finish_platform_classified_withdrawal($1,$2,'acct_vendor','tr_vendor')",
      [claim.id, key]);
    const secondClaim = (await db.query(`select (public.reserve_platform_classified_withdrawal(
      $1,$2,'vendor',40,$3,'acct_vendor',$4::jsonb)).*`, [vendorAccount, vendor,
      `withdrawal:${randomUUID()}`, JSON.stringify([{ vendor_credit_entry_id: movedSecond.payee_entry_id,
        source_net_cents: 40 }])])).rows[0];
    expect(secondClaim.stripe_object_id).toBeNull();
    expect((await db.query("select amount_cents from public.platform_payment_holds where id=$1",
      [f.hold])).rows[0].amount_cents).toBe(40);
    expect((await db.query("select count(*)::integer as n from public.platform_source_consumption_legs where hold_id=$1",
      [f.hold])).rows[0].n).toBe(1);
    await expect(db.query(`select public.reserve_platform_classified_withdrawal(
      $1,$2,'vendor',1,$3,'acct_vendor',$4::jsonb)`, [vendorAccount, vendor,
      `withdrawal:${randomUUID()}`, JSON.stringify([{ vendor_credit_entry_id: moved.payee_entry_id,
        source_net_cents: 1 }])])).rejects.toThrow(/unavailable/);
  });

  it("moves only cleared captured income and consumes the source atomically", async () => {
    const f = await managerHold(100, 100);
    const income = randomUUID(), deposit = randomUUID(), vendor = randomUUID();
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,100,100,100,'resident',p_components=>$5::jsonb)",
      [f.hold, f.owner, f.charge, f.intent, JSON.stringify([
        { source_id: income, kind: "rent", liability_class: "income",
          principal_cents: 80, recipient_net_cents: 80 },
        { source_id: deposit, kind: "security_deposit", liability_class: "deposit",
          principal_cents: 20, recipient_net_cents: 20 },
      ])]);
    await db.query("insert into auth.users(id) values($1)", [vendor]);
    const payer = (await db.query("select public.proplane_balance_ensure_account('workspace',$1,'usd') as id",
      [f.owner])).rows[0].id;
    const payee = (await db.query("select public.proplane_balance_ensure_account('vendor',$1,'usd') as id",
      [vendor])).rows[0].id;
    for (const [source, liability, amount] of [[income, "income", 80], [deposit, "deposit", 20]] as const) {
      await db.query(`insert into public.proplane_balance_entries
        (account_id,amount_cents,kind,status,available_on,idempotency_key,stripe_object_id,
         source_hold_id,source_component_id,source_liability_class)
        values($1,$2,'resident_payment','available',now(),$3,$4,$5,$6,$7)`,
      [payer, amount, `credit:${source}`, f.charge, f.hold, source, liability]);
    }
    const key = `source-move:${randomUUID()}`;
    const incomePart = JSON.stringify([{ hold_id: f.hold, source_id: income, source_net_cents: 40 }]);
    await db.query(`update public.proplane_balance_entries set amount_cents=1
      where source_hold_id=$1 and source_component_id=$2`, [f.hold, income]);
    await db.query(`insert into public.proplane_balance_entries
      (account_id,amount_cents,kind,status,idempotency_key)
      values($1,100,'adjustment','available',$2)`, [payer, `legacy-adjustment:${randomUUID()}`]);
    await expect(db.query(`select * from public.platform_balance_move_from_sources(
      $1,$2,40,$3,$4::jsonb)`, [f.owner, payee, key, incomePart]))
      .rejects.toThrow(/mirror is not cleared/);
    await db.query(`update public.proplane_balance_entries set amount_cents=80
      where source_hold_id=$1 and source_component_id=$2`, [f.hold, income]);
    const first = (await db.query(`select * from public.platform_balance_move_from_sources(
      $1,$2,40,$3,$4::jsonb)`, [f.owner, payee, key, incomePart])).rows[0];
    expect(first.payer_entry_id).toBeTruthy();
    expect(first.payee_entry_id).toBeTruthy();
    expect((await db.query("select amount_cents from public.platform_payment_holds where id=$1",
      [f.hold])).rows[0].amount_cents).toBe(60);
    expect((await db.query("select source_net_cents from public.platform_source_consumption_legs where wallet_debit_entry_id=$1",
      [first.payer_entry_id])).rows).toEqual([{ source_net_cents: 40 }]);
    const retry = (await db.query(`select * from public.platform_balance_move_from_sources(
      $1,$2,40,$3,$4::jsonb)`, [f.owner, payee, key, incomePart])).rows[0];
    expect(retry).toEqual(first);
    await db.query(`update public.platform_source_consumption_legs set source_net_cents=39
      where wallet_debit_entry_id=$1`, [first.payer_entry_id]);
    await expect(db.query(`select * from public.platform_balance_move_from_sources(
      $1,$2,40,$3,$4::jsonb)`, [f.owner, payee, key, incomePart]))
      .rejects.toThrow(/replay changed immutable terms/);
    await db.query(`update public.platform_source_consumption_legs set source_net_cents=40
      where wallet_debit_entry_id=$1`, [first.payer_entry_id]);
    await expect(db.query(`select * from public.platform_balance_move_from_sources(
      $1,$2,20,$3,$4::jsonb)`, [f.owner, payee, `deposit:${randomUUID()}`,
        JSON.stringify([{ hold_id: f.hold, source_id: deposit, source_net_cents: 20 }])]))
      .rejects.toThrow(/captured income/);
    await expect(db.query(`select * from public.platform_balance_move_from_sources(
      $1,$2,41,$3,$4::jsonb)`, [f.owner, payee, `overspend:${randomUUID()}`,
        JSON.stringify([{ hold_id: f.hold, source_id: income, source_net_cents: 41 }])]))
      .rejects.toThrow(/already consumed/);
    const refund = (await db.query(`select (public.reserve_platform_money_refund(
      $1,$2,80,$3,null,80,'requested_by_customer',false,false,$4::jsonb)).*`,
    [f.owner, `refund:${randomUUID()}`, f.hold,
      JSON.stringify([{ source_id: income, principal_cents: 80 }])])).rows[0];
    expect(refund).toMatchObject({ hold_debit_cents: 40, manager_debt_cents: 40 });
  });

  it("serializes overlapping classified wallet moves before either can spend a source twice", async () => {
    const f = await managerHold(100, 100);
    await verifySource(f);
    const vendor = randomUUID();
    await db.query("insert into auth.users(id) values($1)", [vendor]);
    const payer = (await db.query("select public.proplane_balance_ensure_account('workspace',$1,'usd') as id",
      [f.owner])).rows[0].id;
    const payee = (await db.query("select public.proplane_balance_ensure_account('vendor',$1,'usd') as id",
      [vendor])).rows[0].id;
    await db.query(`insert into public.proplane_balance_entries
      (account_id,amount_cents,kind,status,available_on,idempotency_key,stripe_object_id,
       source_hold_id,source_component_id,source_liability_class)
      values($1,100,'resident_payment','available',now(),$2,$3,$4,$5,'income')`,
    [payer, `credit:${randomUUID()}`, f.charge, f.hold, f.source]);
    const first = await db.connect(), second = await db.connect();
    const secondName = `overlap-spend-${randomUUID()}`;
    const parts = JSON.stringify([{ hold_id: f.hold, source_id: f.source, source_net_cents: 60 }]);
    try {
      await first.query("begin");
      await first.query("select * from public.platform_balance_move_from_sources($1,$2,60,$3,$4::jsonb)",
        [f.owner, payee, `move:${randomUUID()}`, parts]);
      await second.query("select set_config('application_name',$1,false)", [secondName]);
      const competing = second.query("select * from public.platform_balance_move_from_sources($1,$2,60,$3,$4::jsonb)",
        [f.owner, payee, `move:${randomUUID()}`, parts]);
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i += 1) {
        const { rows } = await db.query("select wait_event_type from pg_stat_activity where application_name=$1", [secondName]);
        blocked = rows[0]?.wait_event_type === "Lock";
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await first.query("commit");
      await expect(competing).rejects.toThrow(/held remainder|already consumed/);
      expect((await db.query("select amount_cents from public.platform_payment_holds where id=$1",
        [f.hold])).rows[0].amount_cents).toBe(40);
      expect((await db.query("select count(*)::int as n from public.platform_source_consumption_legs where hold_id=$1",
        [f.hold])).rows[0].n).toBe(1);
    } finally {
      await first.query("rollback").catch(() => undefined);
      first.release(); second.release();
    }
  });

  it("keeps eligible income spendable after an exact deposit-only withdrawal", async () => {
    const f = await managerHold(100, 100);
    const income = randomUUID(), deposit = randomUUID(), vendor = randomUUID();
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,100,100,100,'resident',p_components=>$5::jsonb)",
      [f.hold, f.owner, f.charge, f.intent, JSON.stringify([
        { source_id: income, kind: "rent", liability_class: "income",
          principal_cents: 80, recipient_net_cents: 80 },
        { source_id: deposit, kind: "security_deposit", liability_class: "deposit",
          principal_cents: 20, recipient_net_cents: 20 },
      ])]);
    await db.query("insert into auth.users(id) values($1)", [vendor]);
    const payer = (await db.query("select public.proplane_balance_ensure_account('workspace',$1,'usd') as id",
      [f.owner])).rows[0].id;
    const payee = (await db.query("select public.proplane_balance_ensure_account('vendor',$1,'usd') as id",
      [vendor])).rows[0].id;
    for (const [source, liability, amount] of [[income, "income", 80], [deposit, "deposit", 20]] as const) {
      await db.query(`insert into public.proplane_balance_entries
        (account_id,amount_cents,kind,status,available_on,idempotency_key,stripe_object_id,
         source_hold_id,source_component_id,source_liability_class)
        values($1,$2,'resident_payment','available',now(),$3,$4,$5,$6,$7)`,
      [payer, amount, `credit:${source}`, f.charge, f.hold, source, liability]);
    }
    const transfer = `tr_${randomUUID()}`;
    const depositPart = JSON.stringify([{ hold_id: f.hold, source_id: deposit, source_net_cents: 20 }]);
    const debit = (await db.query(`insert into public.proplane_balance_entries
      (account_id,amount_cents,kind,status,idempotency_key,stripe_object_id,
       source_spend_breakdown,source_income_debit_cents)
      values($1,-20,'withdrawal','available',$2,$3,$4::jsonb,0) returning id`,
    [payer, `deposit-withdraw:${randomUUID()}`, transfer, depositPart])).rows[0].id;
    await db.query(`insert into public.platform_source_consumption_legs
      (hold_id,source_component_id,owner_user_id,kind,source_net_cents,
       wallet_debit_entry_id,provider_transfer_id,attempt_key,status)
      values($1,$2,$3,'owner_withdrawal',20,$4,$5,$6,'settled')`,
    [f.hold, deposit, f.owner, debit, transfer, `deposit-use:${randomUUID()}`]);
    await db.query("update public.platform_payment_holds set amount_cents=80 where id=$1", [f.hold]);
    const incomePart = JSON.stringify([{ hold_id: f.hold, source_id: income, source_net_cents: 80 }]);
    const moved = (await db.query(`select * from public.platform_balance_move_from_sources(
      $1,$2,80,$3,$4::jsonb)`, [f.owner, payee, `income-move:${randomUUID()}`, incomePart])).rows[0];
    expect(moved.payer_entry_id).toBeTruthy();
    expect((await db.query("select amount_cents from public.platform_payment_holds where id=$1",
      [f.hold])).rows[0].amount_cents).toBe(0);
  });

  it("credits one pending classified mirror for a captured mixed source and never refills it", async () => {
    const owner = randomUUID(), income = randomUUID(), deposit = randomUUID();
    const charge = `ch_${randomUUID()}`, intent = `pi_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1)", [owner]);
    const parts = JSON.stringify([
      { source_id: income, kind: "rent", liability_class: "income",
        principal_cents: 80, recipient_net_cents: 80 },
      { source_id: deposit, kind: "security_deposit", liability_class: "deposit",
        principal_cents: 20, recipient_net_cents: 20 },
    ]);
    const first = (await db.query(`select * from public.credit_verified_platform_income_mirror(
      $1,'household_charge',$2,$3,$4,100,100,100,'resident',$5::jsonb,null)`,
    [owner, `cs_${randomUUID()}`, charge, intent, parts])).rows[0];
    expect(first.credited).toBe(true);
    expect((await db.query(`select status,amount_cents,source_liability_class,available_on
      from public.proplane_balance_entries where source_hold_id=$1 order by amount_cents desc`,
    [first.hold_id])).rows).toEqual([
      { status: "pending", amount_cents: "80", source_liability_class: "income", available_on: null },
      { status: "pending", amount_cents: "20", source_liability_class: "deposit", available_on: null },
    ]);
    const readyAt = new Date(Date.now() - 60_000).toISOString();
    const replay = (await db.query(`select * from public.credit_verified_platform_income_mirror(
      $1,'household_charge',$2,$3,$4,100,100,100,'resident',$5::jsonb,$6)`,
    [owner, `pi_alias_${randomUUID()}`, charge, intent, parts, readyAt])).rows[0];
    expect(replay).toEqual({ hold_id: first.hold_id, credited: false });
    const account = (await db.query("select id from public.proplane_balance_accounts where owner_key=$1",
      [owner])).rows[0].id;
    await db.query("select public.proplane_balance_settle_due($1)", [account]);
    const vendor = randomUUID();
    await db.query("insert into auth.users(id) values($1)", [vendor]);
    const payee = (await db.query("select public.proplane_balance_ensure_account('vendor',$1,'usd') as id",
      [vendor])).rows[0].id;
    await db.query(`select * from public.platform_balance_move_from_sources(
      $1,$2,40,$3,$4::jsonb)`, [owner, payee, `move:${randomUUID()}`,
      JSON.stringify([{ hold_id: first.hold_id, source_id: income, source_net_cents: 40 }])]);
    const afterSpend = (await db.query(`select * from public.credit_verified_platform_income_mirror(
      $1,'household_charge',$2,$3,$4,100,100,100,'resident',$5::jsonb,$6)`,
    [owner, `cs_replay_${randomUUID()}`, charge, intent, parts, readyAt])).rows[0];
    expect(afterSpend).toEqual({ hold_id: first.hold_id, credited: false });
    expect((await db.query("select amount_cents from public.platform_payment_holds where id=$1",
      [first.hold_id])).rows[0].amount_cents).toBe(60);
    expect((await db.query("select count(*)::int as n from public.proplane_balance_entries where source_hold_id=$1",
      [first.hold_id])).rows[0].n).toBe(2);
    const refundKey = `refund:${randomUUID()}`, refundId = `re_${randomUUID()}`;
    const refund = (await db.query(`select (public.reserve_platform_money_refund(
      $1,$2,80,$3,null,80,'requested_by_customer',false,false,$4::jsonb)).*`,
    [owner, refundKey, first.hold_id,
      JSON.stringify([{ source_id: income, principal_cents: 80 }])])).rows[0];
    expect(refund.hold_debit_cents).toBe(40);
    await db.query("select public.finish_platform_money_refund($1,$2,80)", [refundKey, refundId]);
    await db.query("select public.finish_platform_money_refund($1,$2,80)", [refundKey, refundId]);
    expect((await db.query("select amount_cents from public.platform_payment_holds where id=$1",
      [first.hold_id])).rows[0].amount_cents).toBe(20);
    expect((await db.query(`select count(*)::int as n,sum(amount_cents)::int as debited
      from public.proplane_balance_entries where idempotency_key like $1`,
    [`source-refund:${refund.id}:%`])).rows[0]).toEqual({ n: 1, debited: -40 });
    expect((await db.query("select public.proplane_balance_available_cents($1) as cents",
      [account])).rows[0].cents).toBe("20");
    const afterRefund = (await db.query(`select * from public.credit_verified_platform_income_mirror(
      $1,'household_charge',$2,$3,$4,100,100,100,'resident',$5::jsonb,$6)`,
    [owner, `cs_late_${randomUUID()}`, charge, intent, parts, readyAt])).rows[0];
    expect(afterRefund).toEqual({ hold_id: first.hold_id, credited: false });
    expect((await db.query("select amount_cents from public.platform_payment_holds where id=$1",
      [first.hold_id])).rows[0].amount_cents).toBe(20);
  });

  it("spends only the physical held residual after a completed partial source transfer", async () => {
    const owner = randomUUID(), vendor = randomUUID();
    await db.query("insert into auth.users(id) values($1),($2)", [owner, vendor]);
    const first = await managerHold(100, 100, owner);
    const other = await managerHold(100, 100, owner);
    await verifySource(first); await verifySource(other);
    const payer = (await db.query("select public.proplane_balance_ensure_account('workspace',$1,'usd') as id",
      [owner])).rows[0].id;
    const payee = (await db.query("select public.proplane_balance_ensure_account('vendor',$1,'usd') as id",
      [vendor])).rows[0].id;
    for (const f of [first, other]) {
      await db.query(`insert into public.proplane_balance_entries
        (account_id,amount_cents,kind,status,available_on,idempotency_key,stripe_object_id,
         source_hold_id,source_component_id,source_liability_class)
        values($1,100,'resident_payment','available',now(),$2,$3,$4,$5,'income')`,
      [payer, `source-mirror:${f.hold}:${f.source}`, f.charge, f.hold, f.source]);
    }
    const transfer = `tr_${randomUUID()}`;
    await db.query(`insert into public.platform_hold_transfer_attempts
      (hold_id,attempt_key,owner_user_id,destination_account_id,source_charge_id,
       amount_cents,component_breakdown,status,stripe_transfer_id)
      values($1,$2,$3,'acct_owner',$4,67,$5::jsonb,'created',$6)`,
    [first.hold, `transfer:${randomUUID()}`, owner, first.charge,
      JSON.stringify([{ source_id: first.source, recipient_net_cents: 67 }]), transfer]);
    await db.query("update public.platform_payment_holds set stripe_transfer_id=$2 where id=$1", [first.hold, transfer]);
    await db.query(`insert into public.proplane_balance_entries
      (account_id,amount_cents,kind,status,available_on,idempotency_key,
       source_spend_breakdown,source_income_debit_cents)
      values($1,-67,'adjustment','available',now(),$2,$3::jsonb,67)`,
    [payer, `source-release:${first.hold}:${transfer}`,
      JSON.stringify([{ hold_id: first.hold, source_id: first.source, source_net_cents: 67 }])]);
    const wrong = JSON.stringify([{ hold_id: first.hold, source_id: first.source, source_net_cents: 100 }]);
    await expect(db.query("select public.platform_balance_move_from_sources($1,$2,100,$3,$4::jsonb)",
      [owner, payee, `move:${randomUUID()}`, wrong])).rejects.toThrow(/already consumed or reserved/);
    const mixed = JSON.stringify([
      { hold_id: first.hold, source_id: first.source, source_net_cents: 33 },
      { hold_id: other.hold, source_id: other.source, source_net_cents: 67 },
    ]);
    const trial = await db.connect();
    try {
      await trial.query("begin");
      const key = `move:${randomUUID()}`;
      const moved = (await trial.query("select * from public.platform_balance_move_from_sources($1,$2,100,$3,$4::jsonb)",
        [owner, payee, key, mixed])).rows[0];
      expect(moved.payer_entry_id).toBeTruthy();
      expect((await trial.query("select * from public.platform_balance_move_from_sources($1,$2,100,$3,$4::jsonb)",
        [owner, payee, key, mixed])).rows[0]).toEqual(moved);
      expect((await trial.query("select hold_id,source_net_cents from public.platform_source_consumption_legs where wallet_debit_entry_id=$1 order by hold_id",
        [moved.payer_entry_id])).rows).toEqual([
        { hold_id: first.hold, source_net_cents: 33 },
        { hold_id: other.hold, source_net_cents: 67 },
      ].sort((a, b) => a.hold_id.localeCompare(b.hold_id)));
      expect((await trial.query("select id,amount_cents from public.platform_payment_holds where id=any($1::uuid[]) order by id",
        [[first.hold, other.hold]])).rows).toEqual([
        { id: first.hold, amount_cents: 67 },
        { id: other.hold, amount_cents: 33 },
      ].sort((a, b) => a.id.localeCompare(b.id)));
    } finally {
      await trial.query("rollback");
      trial.release();
    }
    const residual = JSON.stringify([{ hold_id: first.hold, source_id: first.source, source_net_cents: 33 }]);
    expect((await db.query("select * from public.platform_balance_move_from_sources($1,$2,33,$3,$4::jsonb)",
      [owner, payee, `move:${randomUUID()}`, residual])).rows[0].payer_entry_id).toBeTruthy();
    await expect(db.query("select public.platform_balance_move_from_sources($1,$2,1,$3,$4::jsonb)",
      [owner, payee, `move:${randomUUID()}`,
        JSON.stringify([{ hold_id: first.hold, source_id: first.source, source_net_cents: 1 }])]))
      .rejects.toThrow(/already consumed or reserved/);
    expect((await db.query("select amount_cents from public.platform_payment_holds where id=$1", [other.hold])).rows[0].amount_cents)
      .toBe(100);
  });

  it("detaches deleted manager and vendor identities without deleting sourced financial history", async () => {
    const f = await managerHold(100, 100), vendor = randomUUID();
    const managerEmail = `manager-${randomUUID()}@test.invalid`;
    const vendorEmail = `vendor-${randomUUID()}@test.invalid`;
    await db.query("update auth.users set email=$2 where id=$1", [f.owner, managerEmail]);
    await db.query("insert into auth.users(id,email) values($1,$2)", [vendor, vendorEmail]);
    await verifySource(f);
    const payer = (await db.query("select public.proplane_balance_ensure_account('workspace',$1,'usd') as id",
      [f.owner])).rows[0].id;
    const payee = (await db.query("select public.proplane_balance_ensure_account('vendor',$1,'usd') as id",
      [vendor])).rows[0].id;
    await db.query(`insert into public.proplane_balance_entries
      (account_id,amount_cents,kind,status,available_on,idempotency_key,stripe_object_id,
       source_hold_id,source_component_id,source_liability_class)
      values($1,100,'resident_payment','available',now(),$2,$3,$4,$5,'income')`,
    [payer, `credit:${randomUUID()}`, f.charge, f.hold, f.source]);
    await db.query(`select * from public.platform_balance_move_from_sources(
      $1,$2,40,$3,$4::jsonb)`, [f.owner, payee, `move:${randomUUID()}`,
      JSON.stringify([{ hold_id: f.hold, source_id: f.source, source_net_cents: 40 }])]);
    const transfer = (await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).*",
      [f.hold, f.owner, `release:${randomUUID()}`, "acct_owner", f.charge])).rows[0];
    for (const [table, identity, email, column] of [
      ["platform_source_consumption_legs", vendor, vendorEmail, "beneficiary_user_id"],
      ["proplane_balance_accounts", vendor, vendorEmail, "owner_key"],
      ["platform_payment_holds", f.owner, managerEmail, "owner_user_id"],
      ["platform_hold_transfer_attempts", f.owner, managerEmail, "owner_user_id"],
      ["platform_source_consumption_legs", f.owner, managerEmail, "owner_user_id"],
      ["proplane_balance_accounts", f.owner, managerEmail, "owner_key"],
    ]) {
      await db.query("select public.account_preserve_financial_records($1,$2,$3,$4::text[],'{}'::text[])",
        [table, identity, email, [column]]);
    }
    await db.query("delete from auth.users where id in ($1,$2)", [vendor, f.owner]);
    const preserved = (await db.query(`select h.owner_user_id,h.amount_cents,t.owner_user_id as transfer_owner,
      c.owner_user_id as consumption_owner,c.beneficiary_user_id,c.beneficiary_identity_detached,
      c.source_net_cents from public.platform_payment_holds h
      join public.platform_hold_transfer_attempts t on t.hold_id=h.id
      join public.platform_source_consumption_legs c on c.hold_id=h.id where h.id=$1`,
    [f.hold])).rows[0];
    expect(preserved).toMatchObject({ owner_user_id: null, amount_cents: 60,
      transfer_owner: null, consumption_owner: null, beneficiary_user_id: null,
      beneficiary_identity_detached: true, source_net_cents: 40 });
    const accounts = (await db.query("select owner_key from public.proplane_balance_accounts where id=any($1::uuid[])",
      [[payer, payee]])).rows;
    expect(accounts).toHaveLength(2);
    expect(accounts.every((row) => row.owner_key.startsWith("deleted-"))).toBe(true);
    expect((await db.query("select count(*)::int as n from public.proplane_balance_entries where account_id=any($1::uuid[])",
      [[payer, payee]])).rows[0].n).toBe(4);
    const replacement = randomUUID();
    await db.query("insert into auth.users(id,email) values($1,$2)", [replacement, managerEmail]);
    await expect(db.query("update public.platform_payment_holds set owner_user_id=$2 where id=$1",
      [f.hold, replacement])).rejects.toThrow(/Deleted resident identity/);
    await expect(db.query("update public.platform_hold_transfer_attempts set owner_user_id=$2 where id=$1",
      [transfer.id, replacement])).rejects.toThrow(/Deleted resident identity/);
    await expect(db.query("update public.platform_source_consumption_legs set owner_user_id=$2 where hold_id=$1",
      [f.hold, replacement])).rejects.toThrow(/Deleted resident identity/);
    const replacementVendor = randomUUID();
    await db.query("insert into auth.users(id,email) values($1,$2)", [replacementVendor, vendorEmail]);
    await expect(db.query("update public.platform_source_consumption_legs set beneficiary_user_id=$2 where hold_id=$1",
      [f.hold, replacementVendor])).rejects.toThrow(/Deleted resident identity/);
    expect(transfer.id).toBeTruthy();
  });

  it("retains a pending provider refund reservation when its manager identity is deleted", async () => {
    const f = await managerHold(100, 100);
    const email = `refund-owner-${randomUUID()}@test.invalid`;
    await db.query("update auth.users set email=$2 where id=$1", [f.owner, email]);
    await verifySource(f);
    const key = `refund:${randomUUID()}`, providerRefund = `re_${randomUUID()}`;
    const attempt = (await db.query("select (public.reserve_platform_money_refund($1,$2,50,$3,null)).*",
      [f.owner, key, f.hold])).rows[0];
    await db.query("select public.stamp_platform_pending_refund($1,$2,$3,50)",
      [key, providerRefund, f.charge]);
    await db.query("select public.account_preserve_financial_records($1,$2,$3,$4::text[],'{}'::text[])",
      ["platform_payment_holds", f.owner, email, ["owner_user_id"]]);
    await db.query("select public.account_preserve_financial_records($1,$2,$3,$4::text[],'{}'::text[])",
      ["platform_hold_refund_attempts", f.owner, email, ["owner_user_id"]]);
    await db.query("delete from auth.users where id=$1", [f.owner]);
    expect((await db.query(`select id,owner_user_id,hold_id,status,stripe_refund_id,
      source_charge_id,gross_cents from public.platform_hold_refund_attempts where id=$1`,
    [attempt.id])).rows[0]).toMatchObject({ id: attempt.id, owner_user_id: null,
      hold_id: f.hold, status: "reserved", stripe_refund_id: providerRefund,
      source_charge_id: f.charge, gross_cents: 50 });
    expect((await db.query("select owner_user_id,amount_cents from public.platform_payment_holds where id=$1", [f.hold])).rows[0])
      .toEqual({ owner_user_id: null, amount_cents: 100 });
    const replacement = randomUUID();
    await db.query("insert into auth.users(id,email) values($1,$2)", [replacement, email]);
    await expect(db.query("update public.platform_hold_refund_attempts set owner_user_id=$2 where id=$1",
      [attempt.id, replacement])).rejects.toThrow(/Deleted resident identity/);
  });

  it("cancels a pending source projection with pending refund or release, then clears both together", async () => {
    for (const action of ["refund", "release"] as const) {
      const owner = randomUUID(), source = randomUUID();
      const charge = `ch_${randomUUID()}`, intent = `pi_${randomUUID()}`;
      await db.query("insert into auth.users(id) values($1)", [owner]);
      await db.query("insert into public.profiles(id,stripe_connect_account_id) values($1,'acct_owner')", [owner]);
      const parts = JSON.stringify([{ source_id: source, kind: "rent", liability_class: "income",
        principal_cents: 100, recipient_net_cents: 100 }]);
      const first = (await db.query(`select * from public.credit_verified_platform_income_mirror(
        $1,'household_charge',$2,$3,$4,100,100,100,'resident',$5::jsonb,null)`,
      [owner, `cs_${randomUUID()}`, charge, intent, parts])).rows[0];
      const account = (await db.query("select id from public.proplane_balance_accounts where owner_key=$1",
        [owner])).rows[0].id;
      if (action === "refund") {
        const key = `refund:${randomUUID()}`;
        await db.query("select public.reserve_platform_money_refund($1,$2,100,$3,null)",
          [owner, key, first.hold_id]);
        await db.query("select public.finish_platform_money_refund($1,$2,100)",
          [key, `re_${randomUUID()}`]);
      } else {
        const releaseKey = `release:${randomUUID()}`;
        const release = (await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,'acct_owner',$4)).*",
          [first.hold_id, owner, releaseKey, charge])).rows[0];
        expect(release.component_breakdown).toEqual([{ source_id: source, recipient_net_cents: 100 }]);
        const retry = (await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,'acct_owner',$4)).*",
          [first.hold_id, owner, releaseKey, charge])).rows[0];
        expect(retry.id).toBe(release.id);
        const transferId = `tr_${randomUUID()}`;
        await db.query("select public.finish_platform_hold_transfer($1,$2,$3,$4)",
          [first.hold_id, owner, releaseKey, transferId]);
        expect((await db.query(`select stripe_object_id from public.proplane_balance_entries
          where idempotency_key=$1`, [`source-release:${release.id}:${source}`])).rows[0].stripe_object_id)
          .toBe(transferId);
      }
      const before = (await db.query(`select public.proplane_balance_available_cents($1) as available,
        public.proplane_balance_pending_cents($1) as pending`, [account])).rows[0];
      expect(before).toEqual({ available: "0", pending: "0" });
      const clearing = new Date(Date.now() - 60_000).toISOString();
      const replay = (await db.query(`select * from public.credit_verified_platform_income_mirror(
        $1,'household_charge',$2,$3,$4,100,100,100,'resident',$5::jsonb,$6)`,
      [owner, `pi_alias_${randomUUID()}`, charge, intent, parts, clearing])).rows[0];
      expect(replay.hold_id).toBe(first.hold_id);
      await db.query("select public.proplane_balance_settle_due($1)", [account]);
      const after = (await db.query(`select public.proplane_balance_available_cents($1) as available,
        public.proplane_balance_pending_cents($1) as pending`, [account])).rows[0];
      expect(after).toEqual({ available: "0", pending: "0" });
    }
  });

  it("arbitrates distinct PI aliases naming the same actual charge before either credit", async () => {
    const owner = randomUUID(), source = randomUUID(), charge = `ch_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1)", [owner]);
    const components = JSON.stringify([{ source_id: source, kind: "application_fee",
      liability_class: "income", principal_cents: 100, recipient_net_cents: 100 }]);
    const first = await db.connect(), second = await db.connect();
    const secondName = `charge-alias-${randomUUID()}`;
    try {
      await first.query("begin");
      await first.query("select * from public.credit_verified_platform_hold($1,'manager','application_fee',$2,$3,$4,105,100,100,'resident',$5::jsonb)",
        [owner, `cs_${source}`, charge, `pi_${randomUUID()}`, components]);
      await second.query("select set_config('application_name',$1,false)", [secondName]);
      const competing = second.query("select * from public.credit_verified_platform_hold($1,'manager','application_fee',$2,$3,$4,105,100,100,'resident',$5::jsonb)",
        [owner, `pi_alias_${source}`, charge, `pi_${randomUUID()}`, components]);
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i += 1) {
        const { rows } = await db.query("select wait_event_type from pg_stat_activity where application_name=$1", [secondName]);
        blocked = rows[0]?.wait_event_type === "Lock";
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await first.query("commit");
      await expect(competing).rejects.toThrow(/another allocation/);
      expect((await db.query("select count(*)::int as n from public.platform_payment_holds where stripe_charge_id=$1", [charge])).rows[0].n).toBe(1);
    } finally {
      await first.query("rollback").catch(() => undefined);
      first.release(); second.release();
    }
  });

  it("requires complete typed components and derives deposit liability from charge kind", async () => {
    const f = await managerHold();
    const valid = { source_id: f.source, kind: "application_fee", liability_class: "income",
      principal_cents: 100, recipient_net_cents: 100 };
    for (const component of [
      { ...valid, source_id: null },
      { ...valid, kind: null },
      { ...valid, liability_class: null },
      { ...valid, principal_cents: null },
      { ...valid, recipient_net_cents: null },
      { ...valid, principal_cents: "100" },
      { ...valid, principal_cents: 100.5 },
      { ...valid, kind: "security_deposit", liability_class: "income" },
      { ...valid, kind: "rent", liability_class: "deposit" },
      { ...valid, kind: "unknown_kind" },
      null,
    ]) {
      await expect(db.query("select public.verify_platform_hold_source($1,$2,$3,$4,$5,$6,$7,$8,p_components=>$9::jsonb)",
        [f.hold, f.owner, f.charge, f.intent, f.gross, 100, 100, "resident", JSON.stringify([component])]))
        .rejects.toThrow(/components/);
    }
    const deposit = { ...valid, kind: "security_deposit", liability_class: "deposit" };
    expect((await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,$5,$6,$7,$8,p_components=>$9::jsonb) as verified",
      [f.hold, f.owner, f.charge, f.intent, f.gross, 100, 100, "resident", JSON.stringify([deposit])])).rows[0].verified)
      .toBe(true);
  });

  it("credits Checkout and PI aliases only once before either hold becomes visible", async () => {
    const owner = randomUUID(), pi = `pi_${randomUUID()}`, charge = `ch_${randomUUID()}`;
    const source = randomUUID();
    await db.query("insert into auth.users(id) values($1)", [owner]);
    const components = JSON.stringify([{ source_id: source, kind: "application_fee",
      liability_class: "income", principal_cents: 100, recipient_net_cents: 100 }]);
    const blocker = await db.connect(), checkout = await db.connect(), intent = await db.connect();
    const checkoutName = `checkout-credit-${randomUUID()}`, intentName = `pi-credit-${randomUUID()}`;
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`platform-hold-pi:${pi}`]);
      await checkout.query("select set_config('application_name',$1,false)", [checkoutName]);
      await intent.query("select set_config('application_name',$1,false)", [intentName]);
      const credits = Promise.all([
        checkout.query("select * from public.credit_verified_platform_hold($1,'manager','application_fee',$2,$3,$4,105,100,100,'resident',$5::jsonb)",
          [owner, `cs_${randomUUID()}`, charge, pi, components]),
        intent.query("select * from public.credit_verified_platform_hold($1,'manager','application_fee',$2,$3,$4,105,100,100,'resident',$5::jsonb)",
          [owner, pi, charge, pi, components]),
      ]);
      let waiting = 0;
      for (let i = 0; i < 100 && waiting < 2; i += 1) {
        const { rows } = await db.query(`select count(*)::int as n from pg_stat_activity
          where application_name in ($1,$2) and wait_event_type='Lock'`, [checkoutName, intentName]);
        waiting = rows[0].n;
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(2);
      await blocker.query("commit");
      const result = (await credits).map(({ rows }) => rows[0]);
      expect(result.map((row) => row.credited).sort()).toEqual([false, true]);
      expect(new Set(result.map((row) => row.hold_id)).size).toBe(1);
      const { rows } = await db.query(`select count(*)::int as n,coalesce(sum(amount_cents),0)::int as held
        from public.platform_payment_holds where source_payment_intent_id=$1 and status='classified_held'`, [pi]);
      expect(rows[0]).toEqual({ n: 1, held: 100 });
      await expect(db.query("select * from public.credit_verified_platform_hold($1,'manager','application_fee',$2,$3,$4,105,100,100,'resident',$5::jsonb)",
        [owner, `cs_${randomUUID()}`, charge, pi, JSON.stringify([{ source_id: randomUUID(),
          kind: "application_fee", liability_class: "income", principal_cents: 100,
          recipient_net_cents: 100 }])])).rejects.toThrow(/mismatch/);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release(); checkout.release(); intent.release();
    }
  });

  it("holds a mixed rent and deposit cart as one captured allocation", async () => {
    const owner = randomUUID(), pi = `pi_${randomUUID()}`, charge = `ch_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1)", [owner]);
    const components = [
      { source_id: `rent:${randomUUID()}`, kind: "rent", liability_class: "income",
        principal_cents: 60, recipient_net_cents: 60 },
      { source_id: `deposit:${randomUUID()}`, kind: "security_deposit", liability_class: "deposit",
        principal_cents: 40, recipient_net_cents: 40 },
    ];
    const first = (await db.query("select * from public.credit_verified_platform_hold($1,'manager','household_charge',$2,$3,$4,105,100,100,'resident',$5::jsonb)",
      [owner, `cart:${pi}`, charge, pi, JSON.stringify(components)])).rows[0];
    expect(first.credited).toBe(true);
    const replay = (await db.query("select * from public.credit_verified_platform_hold($1,'manager','household_charge',$2,$3,$4,105,100,100,'resident',$5::jsonb)",
      [owner, `charge:${components[0].source_id}`, charge, pi, JSON.stringify(components)])).rows[0];
    expect(replay).toEqual({ hold_id: first.hold_id, credited: false });
    await expect(db.query("select * from public.credit_verified_platform_hold($1,'manager','household_charge',$2,$3,$4,105,60,60,'resident',$5::jsonb)",
      [owner, `charge:${components[0].source_id}`, charge, pi, JSON.stringify([components[0]])]))
      .rejects.toThrow(/mismatch/);
    const { rows } = await db.query("select source_components,amount_cents from public.platform_payment_holds where id=$1", [first.hold_id]);
    expect(rows[0].source_components).toEqual(components);
    expect(rows[0].amount_cents).toBe(100);
  });

  it("reserves exact mixed-cart components and never spends deposit net on income debt", async () => {
    const owner = randomUUID(), charge = `ch_${randomUUID()}`, pi = `pi_${randomUUID()}`;
    const rent = `rent:${randomUUID()}`, deposit = `deposit:${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1)", [owner]);
    const components = [
      { source_id: rent, kind: "rent", liability_class: "income",
        principal_cents: 80, recipient_net_cents: 70 },
      { source_id: deposit, kind: "security_deposit", liability_class: "deposit",
        principal_cents: 20, recipient_net_cents: 20 },
    ];
    const hold = (await db.query("select * from public.credit_verified_platform_hold($1,'manager','household_charge',$2,$3,$4,100,100,90,'manager',$5::jsonb)",
      [owner, `cart:${pi}`, charge, pi, JSON.stringify(components)])).rows[0].hold_id;
    await expect(db.query("select public.reserve_platform_money_refund($1,$2,80,$3,null)",
      [owner, `refund:${randomUUID()}`, hold])).rejects.toThrow(/aggregate refund requires/);
    const rentKey = `refund:${randomUUID()}`;
    const rentAllocation = (await db.query("select (public.reserve_platform_money_refund($1,$2,80,$3,null,p_components=>$4::jsonb)).*",
      [owner, rentKey, hold, JSON.stringify([{ source_id: rent, principal_cents: 80 }])])).rows[0];
    expect(rentAllocation).toMatchObject({ refund_components: [{ source_id: rent, principal_cents: 80 }],
      hold_debit_cents: 70, manager_debt_cents: 10 });
    await db.query("select public.finish_platform_money_refund($1,$2,80)", [rentKey, `re_${randomUUID()}`]);
    await expect(db.query("select public.reserve_platform_money_refund($1,$2,1,$3,null,p_components=>$4::jsonb)",
      [owner, `refund:${randomUUID()}`, hold, JSON.stringify([{ source_id: rent, principal_cents: 1 }])]))
      .rejects.toThrow(/captured component principal/);
    const depositKey = `refund:${randomUUID()}`;
    const depositAllocation = (await db.query("select (public.reserve_platform_money_refund($1,$2,20,$3,null,p_components=>$4::jsonb)).*",
      [owner, depositKey, hold, JSON.stringify([{ source_id: deposit, principal_cents: 20 }])])).rows[0];
    expect(depositAllocation).toMatchObject({ hold_debit_cents: 20, manager_debt_cents: 0 });
    await db.query("select public.finish_platform_money_refund($1,$2,20)", [depositKey, `re_${randomUUID()}`]);
    expect((await db.query("select status,amount_cents from public.platform_payment_holds where id=$1", [hold])).rows[0])
      .toEqual({ status: "refunded", amount_cents: 0 });
  });

  it("refunds manager-paid deposit principal with only its own net and a real owner payable", async () => {
    const f = await managerHold(67, 100);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,100,100,67,'manager',p_components=>$5::jsonb)",
      [f.hold, f.owner, f.charge, f.intent, JSON.stringify([{
        source_id: f.source, kind: "security_deposit", liability_class: "deposit",
        principal_cents: 100, recipient_net_cents: 67,
      }])]);
    const key = `refund:${randomUUID()}`;
    const attempt = (await db.query("select (public.reserve_platform_money_refund($1,$2,100,$3,null)).*",
      [f.owner, key, f.hold])).rows[0];
    expect(attempt).toMatchObject({ hold_debit_cents: 67, manager_debt_cents: 33,
      refund_components: [{ source_id: f.source, principal_cents: 100 }] });
    await db.query("select public.finish_platform_money_refund($1,$2,100)", [key, `re_${randomUUID()}`]);
    expect((await db.query("select amount_cents,status from public.platform_payment_holds where id=$1", [f.hold])).rows[0])
      .toEqual({ amount_cents: 0, status: "refunded" });
  });

  it("will not double-credit a legacy Checkout hold when its PI callback uses another source id", async () => {
    const old = await managerHold(100, 105, undefined, true);
    const components = JSON.stringify([{ source_id: old.source, kind: "application_fee",
      liability_class: "income", principal_cents: 100, recipient_net_cents: 100 }]);
    await expect(db.query("select * from public.credit_verified_platform_hold($1,'manager','application_fee',$2,$3,$4,105,100,100,'resident',$5::jsonb)",
      [old.owner, old.intent, old.charge, old.intent, components]))
      .rejects.toThrow(/legacy allocation/);
    const { rows } = await db.query("select count(*)::int as n,sum(amount_cents)::int as held from public.platform_payment_holds where stripe_charge_id=$1", [old.charge]);
    expect(rows[0]).toEqual({ n: 1, held: 100 });
    expect((await db.query("select source_verified_at from public.platform_payment_holds where id=$1", [old.hold])).rows[0].source_verified_at)
      .toBeNull();
  });

  it("refuses null owner, gross, principal, charge and provider finish terms", async () => {
    const f = await managerHold();
    const components = JSON.stringify([{ source_id: f.source, kind: "application_fee",
      liability_class: "income", principal_cents: 100, recipient_net_cents: 100 }]);
    for (const values of [
      [f.hold, null, f.charge, f.intent, 105, 100, 100, "resident", components],
      [f.hold, f.owner, f.charge, f.intent, null, 100, 100, "resident", components],
      [f.hold, f.owner, f.charge, f.intent, 105, null, 100, "resident", components],
      [f.hold, f.owner, null, f.intent, 105, 100, 100, "resident", components],
    ]) {
      await expect(db.query("select public.verify_platform_hold_source($1,$2,$3,$4,$5,$6,$7,$8,p_components=>$9::jsonb)", values))
        .rejects.toThrow(/cannot be verified/);
    }
    await verifySource(f);
    await expect(db.query("select public.reserve_platform_money_refund($1,$2,$3,$4,null)",
      [f.owner, `refund:${randomUUID()}`, null, f.hold])).rejects.toThrow(/invalid refund/);
    const key = `refund:${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,50,$3,null)", [f.owner, key, f.hold]);
    await expect(db.query("select public.finish_platform_money_refund($1,$2,$3)",
      [key, `re_${randomUUID()}`, null])).rejects.toThrow(/terms mismatch/);
    expect((await db.query("select status from public.platform_hold_refund_attempts where attempt_key=$1", [key])).rows[0].status)
      .toBe("reserved");
  });

  it("releases a reserved refund only with matching terminal provider evidence", async () => {
    const f = await managerHold();
    await verifySource(f);
    const key = `refund:${randomUUID()}`, refund = `re_${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,50,$3,null)", [f.owner, key, f.hold]);
    await expect(db.query("select public.fail_platform_money_refund($1,$2,$3,$4,50)",
      [key, refund, "pending", f.charge])).rejects.toThrow(/terminal refund evidence/);
    await expect(db.query("select public.fail_platform_money_refund($1,$2,$3,$4,50)",
      [key, refund, "failed", "ch_other"])).rejects.toThrow(/terminal refund evidence/);
    expect((await db.query("select public.fail_platform_money_refund($1,$2,$3,$4,50) as changed",
      [key, refund, "failed", f.charge])).rows[0].changed).toBe(true);
    expect((await db.query("select public.fail_platform_money_refund($1,$2,$3,$4,50) as changed",
      [key, refund, "failed", f.charge])).rows[0].changed).toBe(false);
    expect((await db.query("select public.stamp_platform_pending_refund($1,$2,$3,50) as changed",
      [key, refund, f.charge])).rows[0].changed).toBe(false);
    await expect(db.query("select public.fail_platform_money_refund($1,$2,$3,$4,50)",
      [key, `re_${randomUUID()}`, "failed", f.charge])).rejects.toThrow(/does not match reservation/);
    const attempt = (await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).*",
      [f.hold, f.owner, `transfer:${randomUUID()}`, "acct_owner", f.charge])).rows[0];
    expect(attempt).toMatchObject({ amount_cents: 100, status: "reserved" });
    expect((await db.query("select amount_cents from public.platform_payment_holds where id=$1", [f.hold])).rows[0].amount_cents)
      .toBe(100);
  });

  it("binds a pending provider refund ID without debiting funds or allowing a different result", async () => {
    const f = await managerHold();
    await verifySource(f);
    const key = `refund:${randomUUID()}`, refund = `re_${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,50,$3,null)", [f.owner, key, f.hold]);
    expect((await db.query("select public.stamp_platform_pending_refund($1,$2,$3,50) as changed",
      [key, refund, f.charge])).rows[0].changed).toBe(true);
    expect((await db.query("select public.stamp_platform_pending_refund($1,$2,$3,50) as changed",
      [key, refund, f.charge])).rows[0].changed).toBe(false);
    await expect(db.query("select public.stamp_platform_pending_refund($1,$2,$3,50)",
      [key, `re_${randomUUID()}`, f.charge])).rejects.toThrow(/provider terms mismatch/);
    await expect(db.query("select public.finish_platform_money_refund($1,$2,50)",
      [key, `re_${randomUUID()}`])).rejects.toThrow(/provider terms mismatch/);
    expect((await db.query("select amount_cents from public.platform_payment_holds where id=$1", [f.hold])).rows[0].amount_cents)
      .toBe(100);
    expect((await db.query("select public.finish_platform_money_refund($1,$2,50) as changed",
      [key, refund])).rows[0].changed).toBe(true);
    expect((await db.query("select public.stamp_platform_pending_refund($1,$2,$3,50) as changed",
      [key, refund, f.charge])).rows[0].changed).toBe(false);
    expect((await db.query("select amount_cents from public.platform_payment_holds where id=$1", [f.hold])).rows[0].amount_cents)
      .toBe(50);
  });

  it("makes a transfer and refund contend on the same source lock", async () => {
    const f = await managerHold();
    await verifySource(f);
    const blocker = await db.connect(), transfer = await db.connect(), refund = await db.connect();
    const transferName = `hold-transfer-${randomUUID()}`, refundName = `hold-refund-${randomUUID()}`;
    try {
      await blocker.query("begin");
      await blocker.query("select id from public.platform_payment_holds where id=$1 for update", [f.hold]);
      await transfer.query("select set_config('application_name',$1,false)", [transferName]);
      await refund.query("select set_config('application_name',$1,false)", [refundName]);
      const contenders = Promise.allSettled([
        transfer.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).*",
          [f.hold, f.owner, `attempt:${randomUUID()}`, "acct_owner", f.charge]),
        refund.query("select (public.reserve_platform_money_refund($1,$2,$3,$4,null)).*",
          [f.owner, `refund:${randomUUID()}`, 50, f.hold]),
      ]);
      let waiting = 0;
      for (let i = 0; i < 100 && waiting < 2; i += 1) {
        const res = await db.query(`select count(*)::int as n from pg_stat_activity
          where application_name in ($1,$2) and wait_event_type='Lock'`, [transferName, refundName]);
        waiting = res.rows[0].n;
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(2);
      await blocker.query("commit");
      const result = await contenders;
      expect(result.filter((part) => part.status === "fulfilled")).toHaveLength(1);
      expect(result.filter((part) => part.status === "rejected")).toHaveLength(1);
      const { rows: attempts } = await db.query(`select
        (select count(*)::int from public.platform_hold_transfer_attempts where hold_id=$1 and status='reserved') as transfers,
        (select count(*)::int from public.platform_hold_refund_attempts where hold_id=$1 and status='reserved') as refunds`, [f.hold]);
      expect(attempts[0].transfers + attempts[0].refunds).toBe(1);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release(); transfer.release(); refund.release();
    }
  });

  it("rejects a first release when the owner relinks after the readiness read", async () => {
    const f = await managerHold();
    await verifySource(f);
    const blocker = await db.connect(), contender = await db.connect();
    const contenderName = `release-relink-${randomUUID()}`;
    try {
      await blocker.query("begin");
      await blocker.query("select id from public.profiles where id=$1 for update", [f.owner]);
      await contender.query("select set_config('application_name',$1,false)", [contenderName]);
      const reservation = contender.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).*",
        [f.hold, f.owner, `attempt:${randomUUID()}`, "acct_owner", f.charge]);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        const row = (await db.query(`select wait_event_type from pg_stat_activity
          where application_name=$1`, [contenderName])).rows[0];
        waiting = row?.wait_event_type === "Lock";
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await blocker.query("update public.profiles set stripe_connect_account_id='acct_new' where id=$1", [f.owner]);
      await blocker.query("commit");
      await expect(reservation).rejects.toThrow(/destination changed before reservation/);
      expect((await db.query("select count(*)::int as n from public.platform_hold_transfer_attempts where hold_id=$1", [f.hold])).rows[0].n)
        .toBe(0);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release(); contender.release();
    }
  });

  it("reuses immutable transfer terms after retry and binds a later refund to its created transfer", async () => {
    const f = await managerHold();
    await verifySource(f);
    await db.query("update public.profiles set stripe_connect_account_id='acct_original' where id=$1", [f.owner]);
    const key = `attempt:${randomUUID()}`;
    const first = (await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).*",
      [f.hold, f.owner, key, "acct_original", f.charge])).rows[0];
    const retry = (await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).*",
      [f.hold, f.owner, `attempt:${randomUUID()}`, "acct_changed", f.charge])).rows[0];
    expect(retry).toMatchObject({ id: first.id, attempt_key: key,
      destination_account_id: "acct_original", amount_cents: 100 });
    const transferId = `tr_${randomUUID()}`;
    expect((await db.query("select public.finish_platform_hold_transfer($1,$2,$3,$4) as changed",
      [f.hold, f.owner, key, transferId])).rows[0].changed).toBe(true);
    expect((await db.query("select public.finish_platform_hold_transfer($1,$2,$3,$4) as changed",
      [f.hold, f.owner, key, transferId])).rows[0].changed).toBe(false);
    const completedReplay = (await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).*",
      [f.hold, f.owner, `attempt:${randomUUID()}`, "acct_changed", f.charge])).rows[0];
    expect(completedReplay).toMatchObject({ id: first.id, attempt_key: key,
      status: "created", stripe_transfer_id: transferId, destination_account_id: "acct_original" });
    const refundKey = `refund:${randomUUID()}`;
    const refund = (await db.query("select (public.reserve_platform_money_refund($1,$2,$3,$4,null)).*",
      [f.owner, refundKey, 100, f.hold])).rows[0];
    expect(refund).toMatchObject({ hold_id: f.hold, source_charge_id: f.charge,
      hold_debit_cents: 100, status: "reserved" });
    await db.query("select public.finish_platform_money_refund($1,$2,100)", [refundKey, `re_${randomUUID()}`]);
    await db.query("select public.finish_platform_transfer_reversal($1,$2,$3,100)",
      [refundKey, transferId, `trr_${randomUUID()}`]);
    const refundedTransferReplay = (await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).*",
      [f.hold, f.owner, `attempt:${randomUUID()}`, "acct_changed", f.charge])).rows[0];
    expect(refundedTransferReplay).toMatchObject({ id: first.id, stripe_transfer_id: transferId, status: "created" });
    const row = (await db.query("select status,amount_cents,original_amount_cents from public.platform_payment_holds where id=$1", [f.hold])).rows[0];
    expect(row).toMatchObject({ status: "refunded", amount_cents: 0, original_amount_cents: 100 });
    expect((await verifySource(f)).rows[0].verified).toBe(false);
  });

  it("preserves held-refund then remaining-release then destination-refund conservation", async () => {
    const f = await managerHold();
    await verifySource(f);
    const heldKey = `refund:${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,25,$3,null)", [f.owner, heldKey, f.hold]);
    await db.query("select public.finish_platform_money_refund($1,$2,25)", [heldKey, `re_${randomUUID()}`]);
    const transferKey = `transfer:${randomUUID()}`, transferId = `tr_${randomUUID()}`;
    const transfer = (await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).*",
      [f.hold, f.owner, transferKey, "acct_owner", f.charge])).rows[0];
    expect(transfer.amount_cents).toBe(75);
    await db.query("select public.finish_platform_hold_transfer($1,$2,$3,$4)",
      [f.hold, f.owner, transferKey, transferId]);
    const destinationKey = `refund:${randomUUID()}`;
    const destinationRefund = (await db.query("select (public.reserve_platform_money_refund($1,$2,25,$3,null)).*",
      [f.owner, destinationKey, f.hold])).rows[0];
    expect(destinationRefund.hold_debit_cents).toBe(25);
    await db.query("select public.finish_platform_money_refund($1,$2,25)", [destinationKey, `re_${randomUUID()}`]);
    await db.query("select public.finish_platform_transfer_reversal($1,$2,$3,25)",
      [destinationKey, transferId, `trr_${randomUUID()}`]);
    expect((await db.query("select amount_cents,status from public.platform_payment_holds where id=$1", [f.hold])).rows[0])
      .toEqual({ amount_cents: 50, status: "transferred" });
    expect((await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).*",
      [f.hold, f.owner, `transfer:${randomUUID()}`, "acct_new", f.charge])).rows[0])
      .toMatchObject({ id: transfer.id, amount_cents: 75, stripe_transfer_id: transferId });
  });

  it("allocates a small vendor fee cumulatively across partial refunds", async () => {
    const manager = randomUUID(), vendor = randomUUID(), hold = randomUUID(), payout = randomUUID();
    const source = `service-${randomUUID()}`, charge = `ch_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1),($2)", [manager, vendor]);
    await db.query(`insert into public.platform_payment_holds
      (id,owner_user_id,owner_role,source,source_id,amount_cents,status,stripe_charge_id)
      values($1,$2,'vendor','vendor_invoice',$3,97,'classified_held',$4)`, [hold, vendor, source, charge]);
    await db.query(`insert into public.vendor_payouts
      (id,manager_user_id,vendor_user_id,work_order_id,platform_hold_id,amount_cents,platform_fee_cents,status,stripe_charge_id)
      values($1,$2,$3,$4,$5,100,3,'paid',$6)`, [payout, manager, vendor, source, hold, charge]);
    // Manager pays 32 cents of processing in addition to the 100-cent vendor
    // invoice. The vendor's separate three-cent take rate leaves a 97-cent net.
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,132,100,97,'manager',p_components=>$5::jsonb)",
      [hold, vendor, charge, `pi_${randomUUID()}`, JSON.stringify([{
        source_id: source, kind: "vendor_invoice", liability_class: "vendor",
        principal_cents: 100, recipient_net_cents: 97,
      }])]);
    await db.query("update public.vendor_payouts set amount_cents=101 where id=$1", [payout]);
    await expect(db.query("select public.reserve_platform_money_refund($1,$2,50,$3,$4)",
      [vendor, `refund:${randomUUID()}`, hold, payout])).rejects.toThrow(/does not match hold/);
    await db.query("update public.vendor_payouts set amount_cents=100,platform_fee_cents=4 where id=$1", [payout]);
    await expect(db.query("select public.reserve_platform_money_refund($1,$2,50,$3,$4)",
      [vendor, `refund:${randomUUID()}`, hold, payout])).rejects.toThrow(/does not match hold/);
    await db.query("update public.vendor_payouts set platform_fee_cents=3 where id=$1", [payout]);
    const fees: number[] = [], debits: number[] = [];
    for (const refundId of ["re_part_one", "re_part_two"]) {
      const key = `refund:${randomUUID()}`;
      const { rows } = await db.query("select (public.reserve_platform_money_refund($1,$2,50,$3,$4)).*",
        [vendor, key, hold, payout]);
      fees.push(rows[0].fee_share_cents); debits.push(rows[0].hold_debit_cents);
      await db.query("select public.finish_platform_money_refund($1,$2,50)", [key, `${refundId}_${randomUUID()}`]);
    }
    expect(fees).toEqual([2, 1]);
    expect(debits).toEqual([48, 49]);
    expect((await db.query("select amount_cents,status from public.platform_payment_holds where id=$1", [hold])).rows[0])
      .toEqual({ amount_cents: 0, status: "refunded" });
    expect((await db.query("select refunded_gross_cents,refunded_fee_cents,status from public.vendor_payouts where id=$1", [payout])).rows[0])
      .toEqual({ refunded_gross_cents: 100, refunded_fee_cents: 3, status: "refunded" });
  });

  it("freezes the vendor's 48 then 49 net refund reversals after a central hold releases", async () => {
    const manager = randomUUID(), vendor = randomUUID(), invoice = randomUUID();
    const hold = randomUUID(), payout = randomUUID();
    const charge = `ch_${randomUUID()}`, intent = `pi_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1),($2)", [manager, vendor]);
    await db.query("insert into public.profiles(id,stripe_connect_account_id) values($1,'acct_vendor')", [vendor]);
    await db.query(`insert into public.platform_payment_holds
      (id,owner_user_id,owner_role,source,source_id,amount_cents,status,stripe_charge_id)
      values($1,$2,'vendor','vendor_invoice',$3,97,'classified_held',$4)`, [hold, vendor, `direct:${invoice}`, charge]);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,132,100,97,'manager',p_components=>$5::jsonb)",
      [hold, vendor, charge, intent, JSON.stringify([{
        source_id: invoice, kind: "vendor_invoice", liability_class: "vendor",
        principal_cents: 100, recipient_net_cents: 97,
      }])]);
    await db.query(`insert into public.vendor_payouts
      (id,manager_user_id,vendor_user_id,work_order_id,platform_hold_id,amount_cents,platform_fee_cents,status,stripe_charge_id)
      values($1,$2,$3,$4,$5,100,3,'paid',$6)`,
    [payout, manager, vendor, `service-${randomUUID()}`, hold, charge]);
    const transferKey = `transfer:${randomUUID()}`, transfer = `tr_${randomUUID()}`;
    expect((await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).amount_cents as amount",
      [hold, vendor, transferKey, "acct_vendor", charge])).rows[0].amount).toBe(97);
    await db.query("select public.finish_platform_hold_transfer($1,$2,$3,$4)",
      [hold, vendor, transferKey, transfer]);
    for (const [index, expectedNet] of [48, 49].entries()) {
      const key = `refund:${randomUUID()}`;
      const quote = (await db.query("select (public.reserve_platform_money_refund($1,$2,50,$3,$4)).*",
        [vendor, key, hold, payout])).rows[0];
      expect(quote).toMatchObject({ hold_debit_cents: expectedNet,
        held_cash_debit_cents: 0, transfer_reversal_cents: expectedNet });
      expect((await db.query(`select source_transfer_id,amount_cents,component_breakdown
        from public.platform_hold_refund_transfer_legs where refund_attempt_id=$1`, [quote.id])).rows)
        .toEqual([{ source_transfer_id: transfer, amount_cents: expectedNet,
          component_breakdown: [{ source_id: invoice, recipient_net_cents: expectedNet }] }]);
      await db.query("select public.finish_platform_money_refund($1,$2,50)", [key, `re_${randomUUID()}`]);
      const reversal = `trr_${randomUUID()}`;
      expect((await db.query("select public.finish_platform_refund_transfer_leg($1,$2,$3,$4,$5) as changed",
        [key, transfer, reversal, expectedNet, `2026-10-0${5 + index}T11:12:13Z`])).rows[0].changed)
        .toBe(true);
      expect((await db.query("select public.finish_platform_refund_transfer_leg($1,$2,$3,$4,$5) as changed",
        [key, transfer, reversal, expectedNet, `2026-10-0${5 + index}T11:12:13Z`])).rows[0].changed)
        .toBe(false);
    }
    expect((await db.query("select amount_cents,status,stripe_transfer_id from public.platform_payment_holds where id=$1", [hold])).rows[0])
      .toEqual({ amount_cents: 0, status: "refunded", stripe_transfer_id: transfer });
    expect((await db.query("select refunded_gross_cents,refunded_fee_cents,status from public.vendor_payouts where id=$1", [payout])).rows[0])
      .toEqual({ refunded_gross_cents: 100, refunded_fee_cents: 3, status: "refunded" });
  });

  it("does not reserve a second vendor reversal while mixed held and transferred recovery is unknown", async () => {
    const manager = randomUUID(), vendor = randomUUID(), invoice = randomUUID();
    const hold = randomUUID(), payout = randomUUID();
    const charge = `ch_${randomUUID()}`, intent = `pi_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1),($2)", [manager, vendor]);
    await db.query(`insert into public.platform_payment_holds
      (id,owner_user_id,owner_role,source,source_id,amount_cents,status,stripe_charge_id)
      values($1,$2,'vendor','vendor_invoice',$3,300,'classified_held',$4)`, [hold, vendor, `direct:${invoice}`, charge]);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,349,309,300,'manager',p_components=>$5::jsonb)",
      [hold, vendor, charge, intent, JSON.stringify([{
        source_id: invoice, kind: "vendor_invoice", liability_class: "vendor",
        principal_cents: 309, recipient_net_cents: 300,
      }])]);
    await db.query(`insert into public.vendor_payouts
      (id,manager_user_id,vendor_user_id,work_order_id,platform_hold_id,amount_cents,platform_fee_cents,status,stripe_charge_id)
      values($1,$2,$3,$4,$5,309,9,'paid',$6)`,
    [payout, manager, vendor, `service-${randomUUID()}`, hold, charge]);
    // Freeze a valid previously completed two-leg source state so a payer
    // refund can straddle held cash and a transfer whose reversal is unknown.
    for (let i = 0; i < 2; i += 1) {
      await db.query(`insert into public.platform_hold_transfer_attempts
        (hold_id,attempt_key,owner_user_id,destination_account_id,source_charge_id,
         amount_cents,component_breakdown,status,stripe_transfer_id)
        values($1,$2,$3,'acct_vendor',$4,100,$5::jsonb,'created',$6)`,
      [hold, `transfer:${randomUUID()}`, vendor, charge,
        JSON.stringify([{ source_id: invoice, recipient_net_cents: 100 }]), `tr_${randomUUID()}`]);
    }
    const key = `refund:${randomUUID()}`;
    const first = (await db.query("select (public.reserve_platform_money_refund($1,$2,150,$3,$4)).*",
      [vendor, key, hold, payout])).rows[0];
    expect(first).toMatchObject({ held_cash_debit_cents: 100,
      transfer_reversal_cents: 46, hold_debit_cents: 146 });
    const refund = `re_${randomUUID()}`;
    await db.query("select public.finish_platform_money_refund($1,$2,150)", [key, refund]);
    expect((await db.query("select status,reversal_status from public.platform_hold_refund_attempts where id=$1", [first.id])).rows[0])
      .toEqual({ status: "succeeded", reversal_status: "pending" });
    expect((await db.query("select id from public.reserve_platform_money_refund($1,$2,150,$3,$4)",
      [vendor, key, hold, payout])).rows[0].id).toBe(first.id);
    await expect(db.query("select public.reserve_platform_money_refund($1,$2,150,$3,$4)",
      [vendor, `refund:${randomUUID()}`, hold, payout])).rejects.toThrow(/reversal needs review/);
    expect((await db.query("select count(*)::int as n from public.platform_hold_refund_transfer_legs where hold_id=$1", [hold])).rows[0].n)
      .toBe(1);
  });

  it("reserves a vendor payout cap before two different external refund keys can proceed", async () => {
    const manager = randomUUID(), vendor = randomUUID(), payout = randomUUID();
    await db.query("insert into auth.users(id) values($1),($2)", [manager, vendor]);
    await db.query(`insert into public.vendor_payouts
      (id,manager_user_id,vendor_user_id,work_order_id,amount_cents,platform_fee_cents,status,stripe_charge_id)
      values($1,$2,$3,$4,100,3,'paid',$5)`, [payout, manager, vendor, `service-${randomUUID()}`, `ch_${randomUUID()}`]);
    const blocker = await db.connect(), first = await db.connect(), second = await db.connect();
    const firstName = `refund-first-${randomUUID()}`, secondName = `refund-second-${randomUUID()}`;
    try {
      await blocker.query("begin");
      await blocker.query("select id from public.vendor_payouts where id=$1 for update", [payout]);
      await first.query("select set_config('application_name',$1,false)", [firstName]);
      await second.query("select set_config('application_name',$1,false)", [secondName]);
      const contenders = Promise.allSettled([
        first.query("select (public.reserve_platform_money_refund($1,$2,75,null,$3)).*",
          [vendor, `refund:${randomUUID()}`, payout]),
        second.query("select (public.reserve_platform_money_refund($1,$2,75,null,$3)).*",
          [vendor, `refund:${randomUUID()}`, payout]),
      ]);
      let waiting = 0;
      for (let i = 0; i < 100 && waiting < 2; i += 1) {
        const { rows } = await db.query(`select count(*)::int as n from pg_stat_activity
          where application_name in ($1,$2) and wait_event_type='Lock'`, [firstName, secondName]);
        waiting = rows[0].n;
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(2);
      await blocker.query("commit");
      const result = await contenders;
      expect(result.filter((part) => part.status === "fulfilled")).toHaveLength(1);
      expect(result.filter((part) => part.status === "rejected")).toHaveLength(1);
      expect((await db.query("select count(*)::int as n from public.platform_hold_refund_attempts where payout_id=$1 and status='reserved'", [payout])).rows[0].n)
        .toBe(1);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release(); first.release(); second.release();
    }
  });

  it("refunds captured principal rather than dividing by resident-paid gross", async () => {
    const f = await managerHold(5000, 5175);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,5175,5000,5000,'resident',p_components=>$5::jsonb)",
      [f.hold, f.owner, f.charge, f.intent, JSON.stringify([{
        source_id: f.source, kind: "application_fee", liability_class: "income",
        principal_cents: 5000, recipient_net_cents: 5000,
      }])]);
    const key = `refund:${randomUUID()}`;
    const attempt = (await db.query("select (public.reserve_platform_money_refund($1,$2,5000,$3,null)).*",
      [f.owner, key, f.hold])).rows[0];
    expect(attempt).toMatchObject({ principal_cents: 5000, gross_cents: 5000,
      hold_debit_cents: 5000, manager_debt_cents: 0, source_charge_id: f.charge });
    const refund = `re_${randomUUID()}`;
    expect((await db.query("select public.finish_platform_money_refund($1,$2,5000) as changed",
      [key, refund])).rows[0].changed).toBe(true);
    expect((await db.query("select public.finish_platform_money_refund($1,$2,5000) as changed",
      [key, refund])).rows[0].changed).toBe(false);
    await expect(db.query("select public.reserve_platform_money_refund($1,$2,5000,$3,null,null,'duplicate',false,false)",
      [f.owner, key, f.hold])).rejects.toThrow(/immutable terms/);
    await expect(db.query("select public.finish_platform_money_refund($1,$2,5000)",
      [key, `re_${randomUUID()}`])).rejects.toThrow(/provider terms mismatch/);
    expect((await db.query("select status,amount_cents,original_amount_cents from public.platform_payment_holds where id=$1", [f.hold])).rows[0])
      .toMatchObject({ status: "refunded", amount_cents: 0, original_amount_cents: 5000 });
    expect((await verifySource({ ...f, amount: 5000, gross: 5175 })).rows[0].verified).toBe(false);
  });

  it("keeps manager-paid fee retention as an owner debt after principal refunds", async () => {
    const f = await managerHold(4825, 5000);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,5000,5000,4825,'manager',p_components=>$5::jsonb)",
      [f.hold, f.owner, f.charge, f.intent, JSON.stringify([{
        source_id: f.source, kind: "application_fee", liability_class: "income",
        principal_cents: 5000, recipient_net_cents: 4825,
      }])]);
    const allocations: Array<{ principal_cents: number; hold_debit_cents: number; manager_debt_cents: number }> = [];
    for (const n of [0, 1]) {
      const key = `refund:${randomUUID()}`;
      const attempt = (await db.query("select (public.reserve_platform_money_refund($1,$2,2500,$3,null)).*",
        [f.owner, key, f.hold])).rows[0];
      allocations.push(attempt);
      await db.query("select public.finish_platform_money_refund($1,$2,2500)", [key, `re_${randomUUID()}`]);
      if (n === 1) {
        const replay = (await db.query("select (public.reserve_platform_money_refund($1,$2,2500,$3,null)).*",
          [f.owner, key, f.hold])).rows[0];
        expect(replay.id).toBe(attempt.id);
      }
    }
    expect(allocations.map(({ principal_cents, hold_debit_cents, manager_debt_cents }) =>
      ({ principal_cents, hold_debit_cents, manager_debt_cents })))
      .toEqual([
        { principal_cents: 2500, hold_debit_cents: 2500, manager_debt_cents: 0 },
        { principal_cents: 2500, hold_debit_cents: 2325, manager_debt_cents: 175 },
      ]);
    expect((await db.query("select status,amount_cents from public.platform_payment_holds where id=$1", [f.hold])).rows[0])
      .toEqual({ status: "refunded", amount_cents: 0 });
  });

  it("books one immutable held refund ledger and balanced cash/creditor journal", async () => {
    const f = await managerHold(50, 100);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,100,100,50,'manager',p_components=>$5::jsonb)",
      [f.hold, f.owner, f.charge, f.intent, JSON.stringify([{
        source_id: f.source, kind: "rent", liability_class: "income",
        principal_cents: 100, recipient_net_cents: 50,
      }])]);
    await db.query(`insert into public.ledger_entries
      (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,stripe_charge_id,
       property_id,posted_date)
      values($1,'payment','rent_income',100,$2,$3,'property-refund-proof','2026-10-03')`,
    [f.owner, f.source, f.charge]);
    const key = `refund:${randomUUID()}`, providerRefund = `re_${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,100,$3,null)",
      [f.owner, key, f.hold]);
    await db.query("select public.finish_platform_money_refund($1,$2,100)", [key, providerRefund]);
    const book = () => db.query("select public.book_platform_refund_component($1,$2,'2026-10-04T10:11:12Z') as id",
      [key, f.source]);
    const first = (await book()).rows[0].id;
    expect((await book()).rows[0].id).toBe(first);
    const journal = (await db.query(`select e.id,e.source_id,e.entry_date,l.id as ledger_id,
      l.amount_cents,l.posted_date,l.gl_journal_entry_id from public.gl_journal_entries e
      join public.ledger_entries l on l.gl_journal_entry_id=e.id
      where e.id=$1`, [first])).rows[0];
    expect(journal).toMatchObject({ source_id: `refund:${f.source}:${providerRefund}`,
      amount_cents: "100", gl_journal_entry_id: first });
    expect(new Date(journal.entry_date).toISOString().slice(0, 10)).toBe("2026-10-04");
    const lines = (await db.query(`select account_code,debit_cents,credit_cents
      from public.gl_journal_lines where journal_entry_id=$1 order by account_code`, [first])).rows;
    expect(lines).toEqual([
      { account_code: "accounts_payable", debit_cents: "0", credit_cents: "50" },
      { account_code: "operating_cash", debit_cents: "0", credit_cents: "50" },
      { account_code: "rent_income", debit_cents: "100", credit_cents: "0" },
    ]);
    // Three permitted-looking, balanced lines are still invalid when the
    // cash line is duplicated in place of the actual creditor line.
    await db.query("update public.gl_journal_lines set account_code='operating_cash' where journal_entry_id=$1 and account_code='accounts_payable'", [first]);
    await expect(book()).rejects.toThrow(/historical review/);
    expect((await db.query("select count(*)::int as n from public.ledger_entries where source_charge_id=$1 and entry_type='refund'", [f.source])).rows[0].n)
      .toBe(1);
  });

  it("refuses a succeeded refund whose captured settlement mode is missing", async () => {
    const f = await managerHold();
    await verifySource(f);
    await db.query(`insert into public.ledger_entries
      (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,stripe_charge_id,posted_date)
      values($1,'payment','application_fee',100,$2,$3,'2026-10-03')`,
    [f.owner, f.source, f.charge]);
    const key = `refund:${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,100,$3,null)", [f.owner, key, f.hold]);
    await db.query("select public.finish_platform_money_refund($1,$2,100)", [key, `re_${randomUUID()}`]);
    await db.query("update public.platform_hold_refund_attempts set settlement_allocation_mode=null where attempt_key=$1", [key]);
    await expect(db.query("select public.book_platform_refund_component($1,$2,'2026-10-04T10:11:12Z')",
      [key, f.source])).rejects.toThrow(/principal differs|allocation mode needs review/);
    expect((await db.query("select count(*)::int as n from public.ledger_entries where source_charge_id=$1 and entry_type='refund'", [f.source])).rows[0].n)
      .toBe(0);
  });

  it("serializes concurrent canonical refund bookings into one ledger and complete journal", async () => {
    const f = await managerHold(67, 100);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,100,100,67,'manager',p_components=>$5::jsonb)",
      [f.hold, f.owner, f.charge, f.intent, JSON.stringify([{
        source_id: f.source, kind: "rent", liability_class: "income",
        principal_cents: 100, recipient_net_cents: 67,
      }])]);
    await db.query(`insert into public.ledger_entries
      (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,stripe_charge_id,posted_date)
      values($1,'payment','rent_income',100,$2,$3,'2026-10-03')`,
    [f.owner, f.source, f.charge]);
    const key = `refund:${randomUUID()}`, refund = `re_${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,100,$3,null)", [f.owner, key, f.hold]);
    await db.query("select public.finish_platform_money_refund($1,$2,100)", [key, refund]);
    const blocker = await db.connect(), first = await db.connect(), second = await db.connect();
    const firstName = `book-first-${randomUUID()}`, secondName = `book-second-${randomUUID()}`;
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
        [`platform-source-charge:${f.charge}`]);
      await first.query("select set_config('application_name',$1,false)", [firstName]);
      await second.query("select set_config('application_name',$1,false)", [secondName]);
      const bookings = Promise.all([
        first.query("select public.book_platform_refund_component($1,$2,'2026-10-04T10:11:12Z') as id", [key, f.source]),
        second.query("select public.book_platform_refund_component($1,$2,'2026-10-04T10:11:12Z') as id", [key, f.source]),
      ]);
      let waiting = 0;
      for (let i = 0; i < 100 && waiting < 2; i += 1) {
        const { rows } = await db.query(`select count(*)::int as n from pg_stat_activity
          where application_name in ($1,$2) and wait_event_type='Lock'`, [firstName, secondName]);
        waiting = rows[0].n;
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(2);
      await blocker.query("commit");
      const [left, right] = await bookings;
      expect(left.rows[0].id).toBe(right.rows[0].id);
      const { rows } = await db.query(`select
        (select count(*)::int from public.ledger_entries
          where source_charge_id=$1 and entry_type='refund' and stripe_refund_id=$2) as ledger_count,
        (select count(*)::int from public.gl_journal_entries
          where source_type='refund' and source_id=$3) as journal_count,
        (select count(*)::int from public.gl_journal_lines
          where journal_entry_id=$4) as line_count`,
      [f.source, refund, `refund:${f.source}:${refund}`, left.rows[0].id]);
      expect(rows[0]).toEqual({ ledger_count: 1, journal_count: 1, line_count: 3 });
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release(); first.release(); second.release();
    }
  });

  it("books transferred payer refund to a creditor until exact recipient recovery", async () => {
    const f = await managerHold(100, 100);
    await verifySource(f);
    await db.query(`insert into public.ledger_entries
      (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,stripe_charge_id,
       property_id,posted_date)
      values($1,'payment','application_fee',100,$2,$3,'property-transfer-proof','2026-10-03')`,
    [f.owner, f.source, f.charge]);
    const transferKey = `transfer:${randomUUID()}`, transferId = `tr_${randomUUID()}`;
    await db.query("select public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)",
      [f.hold, f.owner, transferKey, "acct_owner", f.charge]);
    await db.query("select public.finish_platform_hold_transfer($1,$2,$3,$4)",
      [f.hold, f.owner, transferKey, transferId]);
    const refundKey = `refund:${randomUUID()}`, providerRefund = `re_${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,100,$3,null)",
      [f.owner, refundKey, f.hold]);
    await db.query("select public.finish_platform_money_refund($1,$2,100)",
      [refundKey, providerRefund]);
    const journalId = (await db.query("select public.book_platform_refund_component($1,$2,'2026-10-04T10:11:12Z') as id",
      [refundKey, f.source])).rows[0].id;
    expect((await db.query(`select account_code,debit_cents,credit_cents
      from public.gl_journal_lines where journal_entry_id=$1 order by account_code`, [journalId])).rows)
      .toEqual([
        { account_code: "accounts_payable", debit_cents: "0", credit_cents: "100" },
        { account_code: "application_fee", debit_cents: "100", credit_cents: "0" },
      ]);
    expect((await db.query("select amount_cents,status from public.platform_payment_holds where id=$1", [f.hold])).rows[0])
      .toEqual({ amount_cents: 100, status: "transferred" });
    const reversalId = `trr_${randomUUID()}`;
    await db.query("select public.finish_platform_transfer_reversal($1,$2,$3,100)",
      [refundKey, transferId, reversalId]);
    const recover = () => db.query("select public.book_platform_refund_recovery_component($1,$2,'2026-10-05T11:12:13Z') as id",
      [refundKey, f.source]);
    const recoveryJournal = (await recover()).rows[0].id;
    expect((await recover()).rows[0].id).toBe(recoveryJournal);
    expect((await db.query(`select account_code,debit_cents,credit_cents
      from public.gl_journal_lines where journal_entry_id=$1 order by account_code`, [recoveryJournal])).rows)
      .toEqual([
        { account_code: "accounts_payable", debit_cents: "100", credit_cents: "0" },
        { account_code: "operating_cash", debit_cents: "0", credit_cents: "100" },
      ]);
    expect((await db.query("select funded_debt_cents,reversal_status from public.platform_hold_refund_attempts where attempt_key=$1", [refundKey])).rows[0])
      .toEqual({ funded_debt_cents: 0, reversal_status: "succeeded" });
  });

  it("permits future-income debt recovery only after every original refund journal is complete", async () => {
    const f = await managerHold(67, 100);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,100,100,67,'manager',p_components=>$5::jsonb)",
      [f.hold, f.owner, f.charge, f.intent, JSON.stringify([{
        source_id: f.source, kind: "rent", liability_class: "income",
        principal_cents: 100, recipient_net_cents: 67,
      }])]);
    await db.query(`insert into public.ledger_entries
      (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,stripe_charge_id,posted_date)
      values($1,'payment','rent_income',100,$2,$3,'2026-10-03')`,
    [f.owner, f.source, f.charge]);
    const key = `refund:${randomUUID()}`, refund = `re_${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,100,$3,null)",
      [f.owner, key, f.hold]);
    await db.query("select public.finish_platform_money_refund($1,$2,100)", [key, refund]);
    const attempt = (await db.query("select id from public.platform_hold_refund_attempts where attempt_key=$1", [key])).rows[0].id;
    const complete = async () => (await db.query("select public.platform_refund_accounting_complete($1) as ok", [attempt])).rows[0].ok;
    expect(await complete()).toBe(false);
    const journal = (await db.query("select public.book_platform_refund_component($1,$2,'2026-10-04T10:11:12Z') as id",
      [key, f.source])).rows[0].id;
    expect(await complete()).toBe(true);
    await db.query("update public.gl_journal_lines set property_id='tampered' where journal_entry_id=$1 and account_code='accounts_payable'", [journal]);
    expect(await complete()).toBe(false);
    await db.query("update public.gl_journal_lines set property_id=null where journal_entry_id=$1 and account_code='accounts_payable'", [journal]);
    expect(await complete()).toBe(true);
    await db.query("update public.platform_hold_refund_attempts set funded_debt_cents=999 where id=$1", [attempt]);
    expect(await complete()).toBe(false);
    await db.query("update public.platform_hold_refund_attempts set funded_debt_cents=33 where id=$1", [attempt]);
    expect(await complete()).toBe(true);
    await db.query("update public.platform_hold_refund_attempts set recipient_debit_components=jsonb_set(recipient_debit_components,'{0,manager_debt_cents}','999'::jsonb) where id=$1", [attempt]);
    expect(await complete()).toBe(false);
    await db.query("update public.platform_hold_refund_attempts set recipient_debit_components=jsonb_set(recipient_debit_components,'{0,manager_debt_cents}','33'::jsonb) where id=$1", [attempt]);
    expect(await complete()).toBe(true);
    await db.query("update public.platform_hold_refund_attempts set settlement_allocation_mode=null where id=$1", [attempt]);
    expect(await complete()).toBe(false);
  });

  it("arbitrates one complete creditor across two fresh income sources before cash recovery", async () => {
    const old = await managerHold(325, 500);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,500,500,325,'manager',p_components=>$5::jsonb)",
      [old.hold, old.owner, old.charge, old.intent, JSON.stringify([{
        source_id: old.source, kind: "rent", liability_class: "income",
        principal_cents: 500, recipient_net_cents: 325,
      }])]);
    await db.query(`insert into public.ledger_entries
      (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,stripe_charge_id,posted_date)
      values($1,'payment','rent_income',500,$2,$3,'2026-10-03')`,
    [old.owner, old.source, old.charge]);
    const refundKey = `refund:${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,500,$3,null)",
      [old.owner, refundKey, old.hold]);
    await db.query("select public.finish_platform_money_refund($1,$2,500)",
      [refundKey, `re_${randomUUID()}`]);
    await db.query("select public.book_platform_refund_component($1,$2,'2026-10-04T10:11:12Z')",
      [refundKey, old.source]);
    const creditor = (await db.query("select id from public.platform_hold_refund_attempts where attempt_key=$1", [refundKey])).rows[0].id;
    const first = await managerHold(1000, 1000, old.owner);
    const second = await managerHold(1000, 1000, old.owner);
    await verifySource(first); await verifySource(second);
    const firstKey = `recovery:${randomUUID()}`, secondKey = `recovery:${randomUUID()}`;
    const blocker = await db.connect(), left = await db.connect(), right = await db.connect();
    const leftName = `recover-left-${randomUUID()}`, rightName = `recover-right-${randomUUID()}`;
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
        [`platform-owner-recovery:${old.owner}`]);
      await left.query("select set_config('application_name',$1,false)", [leftName]);
      await right.query("select set_config('application_name',$1,false)", [rightName]);
      const attempts = Promise.allSettled([
        left.query("select (public.reserve_platform_owner_recovery($1,$2,$3,$4,175,$5)).*",
          [old.owner, first.hold, creditor, first.source, firstKey]),
        right.query("select (public.reserve_platform_owner_recovery($1,$2,$3,$4,175,$5)).*",
          [old.owner, second.hold, creditor, second.source, secondKey]),
      ]);
      let waiting = 0;
      for (let i = 0; i < 100 && waiting < 2; i += 1) {
        waiting = (await db.query(`select count(*)::int as n from pg_stat_activity
          where application_name in ($1,$2) and wait_event_type='Lock'`, [leftName, rightName])).rows[0].n;
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(2);
      await blocker.query("commit");
      const results = await attempts;
      expect(results.filter((part) => part.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((part) => part.status === "rejected")).toHaveLength(1);
      const winner = results[0].status === "fulfilled" ? { source: first, key: firstKey } :
        { source: second, key: secondKey };
      const replay = (await db.query("select (public.reserve_platform_owner_recovery($1,$2,$3,$4,175,$5)).*",
        [old.owner, winner.source.hold, creditor, winner.source.source, winner.key])).rows[0];
      expect(replay).toMatchObject({ source_net_cents: 175, status: "reserved",
        source_charge_id: winner.source.charge, source_payment_intent_id: winner.source.intent });
      await expect(db.query("select public.reserve_platform_owner_recovery($1,$2,$3,$4,176,$5)",
        [old.owner, winner.source.hold, creditor, winner.source.source, winner.key]))
        .rejects.toThrow(/immutable source/);
      expect((await db.query("select recovered_cents from public.platform_hold_refund_attempts where id=$1", [creditor])).rows[0].recovered_cents)
        .toBe(0);
      expect((await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).amount_cents as amount",
        [winner.source.hold, old.owner, `transfer:${randomUUID()}`, "acct_owner", winner.source.charge])).rows[0].amount)
        .toBe(825);
      const origin = (await db.query(`insert into public.gl_journal_entries
        (manager_user_id,entry_date,source_type,source_id)
        values($1,'2026-10-03','payment',$2) returning id`,
      [old.owner, winner.source.source])).rows[0].id;
      await db.query(`insert into public.gl_journal_lines
        (journal_entry_id,account_code,debit_cents,credit_cents)
        values($1,'operating_cash',1000,0),($1,'accounts_receivable',0,1000)`, [origin]);
      await db.query(`insert into public.ledger_entries
        (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,
         stripe_charge_id,posted_date,gl_journal_entry_id)
        values($1,'payment','application_fee',1000,$2,$3,'2026-10-03',$4)`,
      [old.owner, winner.source.source, winner.source.charge, origin]);
      const chargeJournal = (await db.query(`insert into public.gl_journal_entries
        (manager_user_id,entry_date,source_type,source_id)
        values($1,'2026-10-03','charge',$2) returning id`,
      [old.owner, winner.source.source])).rows[0].id;
      await db.query(`insert into public.gl_journal_lines
        (journal_entry_id,account_code,debit_cents,credit_cents)
        values($1,'accounts_receivable',1000,0),($1,'application_fee',0,1000)`, [chargeJournal]);
      await db.query(`insert into public.ledger_entries
        (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,
         posted_date,gl_journal_entry_id)
        values($1,'charge','application_fee',1000,$2,'2026-10-03',$3)`,
      [old.owner, winner.source.source, chargeJournal]);
      const clearedAt = new Date(Date.now() - 60_000).toISOString();
      const attestedAt = new Date().toISOString();
      const balanceTransaction = `txn_${randomUUID()}`;
      await expect(db.query(`select public.settle_platform_owner_recovery(
        $1,$2,$3,$4,$5,$6)`, [winner.key, winner.source.charge,
          winner.source.intent, balanceTransaction, new Date(Date.now() + 60_000).toISOString(), attestedAt]))
        .rejects.toThrow(/fresh cleared provider evidence/);
      expect((await db.query("select recovered_cents from public.platform_hold_refund_attempts where id=$1", [creditor])).rows[0].recovered_cents)
        .toBe(0);
      expect((await db.query("select public.settle_platform_owner_recovery($1,$2,$3,$4,$5,$6) as changed",
        [winner.key, winner.source.charge, winner.source.intent, balanceTransaction,
          clearedAt, attestedAt])).rows[0].changed).toBe(true);
      expect((await db.query("select public.settle_platform_owner_recovery($1,$2,$3,$4,$5,$6) as changed",
        [winner.key, winner.source.charge, winner.source.intent, balanceTransaction,
          clearedAt, new Date().toISOString()])).rows[0].changed).toBe(false);
      expect((await db.query("select recovered_cents from public.platform_hold_refund_attempts where id=$1", [creditor])).rows[0].recovered_cents)
        .toBe(175);
      expect((await db.query("select amount_cents,status from public.platform_payment_holds where id=$1", [winner.source.hold])).rows[0])
        .toEqual({ amount_cents: 825, status: "classified_held" });
      const settledLeg = (await db.query(`select status,source_balance_transaction_id,
        recovery_journal_id from public.platform_source_consumption_legs where attempt_key=$1`, [winner.key])).rows[0];
      expect(settledLeg).toMatchObject({ status: "settled", source_balance_transaction_id: balanceTransaction });
      expect((await db.query(`select account_code,debit_cents,credit_cents
        from public.gl_journal_lines where journal_entry_id=$1 order by account_code`,
      [settledLeg.recovery_journal_id])).rows).toEqual([
        { account_code: "accounts_payable", debit_cents: "175", credit_cents: "0" },
        { account_code: "operating_cash", debit_cents: "0", credit_cents: "175" },
      ]);
      await expect(db.query("select public.settle_platform_owner_recovery($1,$2,$3,$4,$5,$6)",
        [winner.key, winner.source.charge, winner.source.intent, `txn_${randomUUID()}`,
          clearedAt, new Date().toISOString()])).rejects.toThrow(/replay changed provider/);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release(); left.release(); right.release();
    }
  });

  it("keeps only the still-backed owner offset after a succeeded partial source refund", async () => {
    const old = await managerHold(325, 500);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,500,500,325,'manager',p_components=>$5::jsonb)",
      [old.hold, old.owner, old.charge, old.intent, JSON.stringify([{
        source_id: old.source, kind: "rent", liability_class: "income",
        principal_cents: 500, recipient_net_cents: 325,
      }])]);
    await db.query(`insert into public.ledger_entries
      (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,stripe_charge_id,posted_date)
      values($1,'payment','rent_income',500,$2,$3,'2026-10-03')`,
    [old.owner, old.source, old.charge]);
    const creditorKey = `refund:${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,500,$3,null)",
      [old.owner, creditorKey, old.hold]);
    await db.query("select public.finish_platform_money_refund($1,$2,500)",
      [creditorKey, `re_${randomUUID()}`]);
    await db.query("select public.book_platform_refund_component($1,$2,'2026-10-04T10:11:12Z')",
      [creditorKey, old.source]);
    const creditor = (await db.query("select id from public.platform_hold_refund_attempts where attempt_key=$1", [creditorKey])).rows[0].id;
    const income = await managerHold(1000, 1000, old.owner);
    await verifySource(income);
    const offsetKey = `recovery:${randomUUID()}`;
    const offset = (await db.query("select (public.reserve_platform_owner_recovery($1,$2,$3,$4,175,$5)).*",
      [old.owner, income.hold, creditor, income.source, offsetKey])).rows[0];
    const transferKey = `transfer:${randomUUID()}`, transfer = `tr_${randomUUID()}`;
    expect((await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).amount_cents as amount",
      [income.hold, income.owner, transferKey, "acct_owner", income.charge])).rows[0].amount).toBe(825);
    await db.query("select public.finish_platform_hold_transfer($1,$2,$3,$4)",
      [income.hold, income.owner, transferKey, transfer]);
    await expect(db.query("select public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)",
      [income.hold, income.owner, `transfer:${randomUUID()}`, "acct_owner", income.charge]))
      .rejects.toThrow(/no releasable residual/);
    const firstKey = `refund:${randomUUID()}`, firstRefund = `re_${randomUUID()}`;
    const first = (await db.query("select (public.reserve_platform_money_refund($1,$2,100,$3,null)).*",
      [income.owner, firstKey, income.hold])).rows[0];
    expect(first).toMatchObject({ held_cash_debit_cents: 100, transfer_reversal_cents: 0 });
    expect((await db.query("select status,source_net_cents from public.platform_source_consumption_legs where id=$1", [offset.id])).rows[0])
      .toEqual({ status: "reserved", source_net_cents: 175 });
    await db.query("select public.finish_platform_money_refund($1,$2,100)", [firstKey, firstRefund]);
    expect((await db.query("select public.finish_platform_money_refund($1,$2,100) as changed",
      [firstKey, firstRefund])).rows[0].changed).toBe(false);
    const lineage = (await db.query(`select attempt_key,status,source_net_cents,predecessor_leg_id,
      replacement_refund_attempt_id from public.platform_source_consumption_legs
      where id=$1 or predecessor_leg_id=$1 order by created_at,id`, [offset.id])).rows;
    expect(lineage).toHaveLength(2);
    expect(lineage.find((row) => row.status === "superseded")).toMatchObject({
      source_net_cents: 175, replacement_refund_attempt_id: first.id,
    });
    expect(lineage.find((row) => row.status === "reserved")).toMatchObject({
      source_net_cents: 75, predecessor_leg_id: offset.id,
      replacement_refund_attempt_id: first.id,
    });
    const successorKey = lineage.find((row) => row.status === "reserved")?.attempt_key as string;
    expect((await db.query("select recovered_cents from public.platform_hold_refund_attempts where id=$1", [creditor])).rows[0].recovered_cents)
      .toBe(0);
    // Clearing can repay the successor once the exact partial refund has
    // settled; roll back this branch to also prove a later full refund cancels
    // an uncleared successor without touching the old creditor.
    const trial = await db.connect();
    try {
      await trial.query("begin");
      const paymentJournal = (await trial.query(`insert into public.gl_journal_entries
        (manager_user_id,entry_date,source_type,source_id)
        values($1,'2026-10-03','payment',$2) returning id`,
      [income.owner, income.source])).rows[0].id;
      await trial.query(`insert into public.gl_journal_lines
        (journal_entry_id,account_code,debit_cents,credit_cents)
        values($1,'operating_cash',1000,0),($1,'accounts_receivable',0,1000)`, [paymentJournal]);
      await trial.query(`insert into public.ledger_entries
        (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,
         stripe_charge_id,posted_date,gl_journal_entry_id)
        values($1,'payment','application_fee',1000,$2,$3,'2026-10-03',$4)`,
      [income.owner, income.source, income.charge, paymentJournal]);
      const chargeJournal = (await trial.query(`insert into public.gl_journal_entries
        (manager_user_id,entry_date,source_type,source_id)
        values($1,'2026-10-03','charge',$2) returning id`,
      [income.owner, income.source])).rows[0].id;
      await trial.query(`insert into public.gl_journal_lines
        (journal_entry_id,account_code,debit_cents,credit_cents)
        values($1,'accounts_receivable',1000,0),($1,'application_fee',0,1000)`, [chargeJournal]);
      await trial.query(`insert into public.ledger_entries
        (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,
         posted_date,gl_journal_entry_id)
        values($1,'charge','application_fee',1000,$2,'2026-10-03',$3)`,
      [income.owner, income.source, chargeJournal]);
      const balanceTransaction = `txn_${randomUUID()}`;
      const availableOn = new Date(Date.now() - 60_000).toISOString();
      const settle = [successorKey, income.charge, income.intent,
        balanceTransaction, availableOn, new Date().toISOString()];
      expect((await trial.query("select public.settle_platform_owner_recovery($1,$2,$3,$4,$5,$6) as changed",
        settle)).rows[0].changed).toBe(true);
      expect((await trial.query("select public.settle_platform_owner_recovery($1,$2,$3,$4,$5,$6) as changed",
        [...settle.slice(0, 5), new Date().toISOString()])).rows[0].changed).toBe(false);
      expect((await trial.query("select recovered_cents from public.platform_hold_refund_attempts where id=$1", [creditor])).rows[0].recovered_cents)
        .toBe(75);
      expect((await trial.query("select amount_cents,status from public.platform_payment_holds where id=$1", [income.hold])).rows[0])
        .toEqual({ amount_cents: 825, status: "transferred" });
    } finally {
      await trial.query("rollback");
      trial.release();
    }
    await expect(db.query("select public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)",
      [income.hold, income.owner, `transfer:${randomUUID()}`, "acct_owner", income.charge]))
      .rejects.toThrow(/no releasable residual/);
    const finalKey = `refund:${randomUUID()}`;
    const final = (await db.query("select (public.reserve_platform_money_refund($1,$2,900,$3,null)).*",
      [income.owner, finalKey, income.hold])).rows[0];
    expect(final).toMatchObject({ held_cash_debit_cents: 75, transfer_reversal_cents: 825 });
    await db.query("select public.finish_platform_money_refund($1,$2,900)", [finalKey, `re_${randomUUID()}`]);
    expect((await db.query(`select coalesce(sum(source_net_cents),0)::int as cents
      from public.platform_source_consumption_legs
      where hold_id=$1 and kind='owner_debt_recovery' and status='reserved'`, [income.hold])).rows[0].cents)
      .toBe(0);
    expect((await db.query("select recovered_cents from public.platform_hold_refund_attempts where id=$1", [creditor])).rows[0].recovered_cents)
      .toBe(0);
  });

  it("credits new income, reserves established owner debt and mirrors the source atomically", async () => {
    const old = await managerHold(325, 500);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,500,500,325,'manager',p_components=>$5::jsonb)",
      [old.hold, old.owner, old.charge, old.intent, JSON.stringify([{
        source_id: old.source, kind: "rent", liability_class: "income",
        principal_cents: 500, recipient_net_cents: 325,
      }])]);
    await db.query(`insert into public.ledger_entries
      (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,stripe_charge_id,posted_date)
      values($1,'payment','rent_income',500,$2,$3,'2026-10-03')`,
    [old.owner, old.source, old.charge]);
    const creditorKey = `refund:${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,500,$3,null)",
      [old.owner, creditorKey, old.hold]);
    await db.query("select public.finish_platform_money_refund($1,$2,500)",
      [creditorKey, `re_${randomUUID()}`]);
    await db.query("select public.book_platform_refund_component($1,$2,'2026-10-04T10:11:12Z')",
      [creditorKey, old.source]);
    const creditor = (await db.query("select id from public.platform_hold_refund_attempts where attempt_key=$1",
      [creditorKey])).rows[0].id;
    const source = randomUUID(), charge = `ch_${source}`, intent = `pi_${source}`;
    const args = [old.owner, "application_fee", `cs_${source}`, charge, intent,
      1000, 1000, 1000, "resident", JSON.stringify([{
        source_id: source, kind: "application_fee", liability_class: "income",
        principal_cents: 1000, recipient_net_cents: 1000,
      }])];
    const first = (await db.query(`select * from public.credit_platform_income_with_recovery(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, args)).rows[0];
    expect(first).toMatchObject({ credited: true, reserved_cents: 175 });
    const replay = (await db.query(`select * from public.credit_platform_income_with_recovery(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, args)).rows[0];
    expect(replay).toMatchObject({ hold_id: first.hold_id, credited: false, reserved_cents: 0 });
    expect((await db.query(`select source_net_cents,status from public.platform_source_consumption_legs
      where hold_id=$1 and creditor_refund_attempt_id=$2`, [first.hold_id, creditor])).rows)
      .toEqual([{ source_net_cents: 175, status: "reserved" }]);
    expect((await db.query(`select amount_cents::integer,source_liability_class from public.proplane_balance_entries
      where source_hold_id=$1 and kind='resident_payment'`, [first.hold_id])).rows)
      .toEqual([{ amount_cents: 1000, source_liability_class: "income" }]);
    expect((await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).amount_cents as amount",
      [first.hold_id, old.owner, `transfer:${randomUUID()}`, "acct_owner", charge])).rows[0].amount)
      .toBe(825);
    const clearingDate = "2026-10-08T00:00:00Z";
    const hydrated = (await db.query(`select * from public.credit_platform_income_with_recovery(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::timestamptz)`,
      [...args, clearingDate])).rows[0];
    expect(hydrated).toMatchObject({ hold_id: first.hold_id, credited: false,
      reserved_cents: 0 });
    const clearingEpoch = Math.floor(Date.parse(clearingDate) / 1000);
    expect((await db.query(`select amount_cents::integer,
      extract(epoch from available_on)::bigint::integer as available_epoch
      from public.proplane_balance_entries where account_id=(
        select account_id from public.proplane_balance_entries
        where source_hold_id=$1 and kind='resident_payment' limit 1)
        and (source_hold_id=$1 or source_spend_breakdown @>
          jsonb_build_array(jsonb_build_object('hold_id',$1::uuid,'source_id',$2::text)))
      order by amount_cents`, [first.hold_id, source])).rows)
      .toEqual([{ amount_cents: -825, available_epoch: clearingEpoch },
        { amount_cents: 1000, available_epoch: clearingEpoch }]);
  });

  it("holds transferred-source debt eligibility until exact recipient reversal books", async () => {
    const f = await managerHold(67, 100);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,100,100,67,'manager',p_components=>$5::jsonb)",
      [f.hold, f.owner, f.charge, f.intent, JSON.stringify([{
        source_id: f.source, kind: "rent", liability_class: "income",
        principal_cents: 100, recipient_net_cents: 67,
      }])]);
    await db.query(`insert into public.ledger_entries
      (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,stripe_charge_id,posted_date)
      values($1,'payment','rent_income',100,$2,$3,'2026-10-03')`,
    [f.owner, f.source, f.charge]);
    const transferKey = `transfer:${randomUUID()}`, transfer = `tr_${randomUUID()}`;
    await db.query("select public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)",
      [f.hold, f.owner, transferKey, "acct_owner", f.charge]);
    await db.query("select public.finish_platform_hold_transfer($1,$2,$3,$4)",
      [f.hold, f.owner, transferKey, transfer]);
    const key = `refund:${randomUUID()}`, refund = `re_${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,100,$3,null)",
      [f.owner, key, f.hold]);
    await db.query("select public.finish_platform_money_refund($1,$2,100)", [key, refund]);
    const attempt = (await db.query("select id from public.platform_hold_refund_attempts where attempt_key=$1", [key])).rows[0].id;
    const complete = async () => (await db.query("select public.platform_refund_accounting_complete($1) as ok", [attempt])).rows[0].ok;
    expect(await complete()).toBe(false);
    await db.query("select public.book_platform_refund_component($1,$2,'2026-10-04T10:11:12Z')", [key, f.source]);
    expect(await complete()).toBe(false);
    const reversal = `trr_${randomUUID()}`;
    await db.query("select public.finish_platform_refund_transfer_leg($1,$2,$3,67,'2026-10-05T11:12:13Z')",
      [key, transfer, reversal]);
    expect(await complete()).toBe(false);
    await db.query("select public.book_platform_refund_transfer_recovery_component($1,$2,$3)",
      [key, reversal, f.source]);
    expect(await complete()).toBe(true);
  });

  it("requires the held cash and every exact transfer recovery journal before mixed debt is eligible", async () => {
    const creditorSource = await managerHold(67, 100);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,100,100,67,'manager',p_components=>$5::jsonb)",
      [creditorSource.hold, creditorSource.owner, creditorSource.charge, creditorSource.intent,
        JSON.stringify([{ source_id: creditorSource.source, kind: "rent", liability_class: "income",
          principal_cents: 100, recipient_net_cents: 67 }])]);
    await db.query(`insert into public.ledger_entries
      (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,stripe_charge_id,posted_date)
      values($1,'payment','rent_income',100,$2,$3,'2026-10-03')`,
    [creditorSource.owner, creditorSource.source, creditorSource.charge]);
    const oldKey = `refund:${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,100,$3,null)",
      [creditorSource.owner, oldKey, creditorSource.hold]);
    await db.query("select public.finish_platform_money_refund($1,$2,100)", [oldKey, `re_${randomUUID()}`]);
    const creditor = (await db.query("select id from public.platform_hold_refund_attempts where attempt_key=$1", [oldKey])).rows[0].id;

    const f = await managerHold(825, 1000, creditorSource.owner);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,1000,1000,825,'manager',p_components=>$5::jsonb)",
      [f.hold, f.owner, f.charge, f.intent, JSON.stringify([{
        source_id: f.source, kind: "application_fee", liability_class: "income",
        principal_cents: 1000, recipient_net_cents: 825,
      }])]);
    await db.query(`insert into public.ledger_entries
      (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,stripe_charge_id,posted_date)
      values($1,'payment','application_fee',1000,$2,$3,'2026-10-03')`,
    [f.owner, f.source, f.charge]);
    const offsetKey = `recovery:${randomUUID()}`;
    await db.query(`insert into public.platform_source_consumption_legs
      (hold_id,source_component_id,owner_user_id,kind,source_net_cents,
       creditor_refund_attempt_id,source_charge_id,source_payment_intent_id,attempt_key,status)
      values($1,$2,$3,'owner_debt_recovery',175,$4,$5,$6,$7,'reserved')`,
    [f.hold, f.source, f.owner, creditor, f.charge, f.intent, offsetKey]);
    const transferKey = `transfer:${randomUUID()}`, transfer = `tr_${randomUUID()}`;
    expect((await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).amount_cents as amount",
      [f.hold, f.owner, transferKey, "acct_owner", f.charge])).rows[0].amount).toBe(650);
    await db.query("select public.finish_platform_hold_transfer($1,$2,$3,$4)",
      [f.hold, f.owner, transferKey, transfer]);
    // The old offset was conclusively canceled; cash not sent to Connect is
    // available for this source's payer refund, alongside exact transfer650.
    await db.query("update public.platform_source_consumption_legs set status='failed' where attempt_key=$1", [offsetKey]);
    const key = `refund:${randomUUID()}`, refund = `re_${randomUUID()}`;
    const quote = (await db.query("select (public.reserve_platform_money_refund($1,$2,1000,$3,null)).*",
      [f.owner, key, f.hold])).rows[0];
    expect(quote).toMatchObject({ held_cash_debit_cents: 175,
      transfer_reversal_cents: 650, hold_debit_cents: 825, manager_debt_cents: 175 });
    await db.query("select public.finish_platform_money_refund($1,$2,1000)", [key, refund]);
    const complete = async () => (await db.query("select public.platform_refund_accounting_complete($1) as ok", [quote.id])).rows[0].ok;
    expect(await complete()).toBe(false);
    await db.query("select public.book_platform_refund_component($1,$2,'2026-10-04T10:11:12Z')", [key, f.source]);
    expect(await complete()).toBe(false);
    const reversal = `trr_${randomUUID()}`;
    await db.query("select public.finish_platform_refund_transfer_leg($1,$2,$3,650,'2026-10-05T11:12:13Z')",
      [key, transfer, reversal]);
    expect(await complete()).toBe(false);
    const journal = (await db.query("select public.book_platform_refund_transfer_recovery_component($1,$2,$3) as id",
      [key, reversal, f.source])).rows[0].id;
    expect(await complete()).toBe(true);
    await db.query("update public.gl_journal_lines set credit_cents=649 where journal_entry_id=$1 and account_code='operating_cash'", [journal]);
    expect(await complete()).toBe(false);
    await db.query("update public.gl_journal_lines set credit_cents=650 where journal_entry_id=$1 and account_code='operating_cash'", [journal]);
    expect(await complete()).toBe(true);
  });

  it("keeps each residual source transfer immutable and reserves only unrecovered owner debt", async () => {
    const old = await managerHold(825, 1000);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,1000,1000,825,'manager',p_components=>$5::jsonb)",
      [old.hold, old.owner, old.charge, old.intent, JSON.stringify([{
        source_id: old.source, kind: "rent", liability_class: "income",
        principal_cents: 1000, recipient_net_cents: 825,
      }])]);
    await db.query(`insert into public.ledger_entries
      (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,stripe_charge_id,posted_date)
      values($1,'payment','rent_income',1000,$2,$3,'2026-10-03')`,
    [old.owner, old.source, old.charge]);
    const refundKey = `refund:${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,1000,$3,null)",
      [old.owner, refundKey, old.hold]);
    await db.query("select public.finish_platform_money_refund($1,$2,1000)",
      [refundKey, `re_${randomUUID()}`]);
    await db.query("select public.book_platform_refund_component($1,$2,'2026-10-04T10:11:12Z')",
      [refundKey, old.source]);
    const creditor = (await db.query("select id from public.platform_hold_refund_attempts where attempt_key=$1", [refundKey])).rows[0].id;
    const income = await managerHold(1000, 1000, old.owner);
    await verifySource(income);
    const debtKey = `recovery:${randomUUID()}`;
    await db.query(`insert into public.platform_source_consumption_legs
      (hold_id,source_component_id,owner_user_id,kind,source_net_cents,
       creditor_refund_attempt_id,source_charge_id,source_payment_intent_id,attempt_key,status)
      values($1,$2,$3,'owner_debt_recovery',175,$4,$5,$6,$7,'reserved')`,
    [income.hold, income.source, income.owner, creditor, income.charge, income.intent, debtKey]);
    const firstKey = `transfer:${randomUUID()}`, firstId = `tr_${randomUUID()}`;
    const first = (await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).*",
      [income.hold, income.owner, firstKey, "acct_owner", income.charge])).rows[0];
    expect(first.amount_cents).toBe(825);
    await db.query("select public.finish_platform_hold_transfer($1,$2,$3,$4)",
      [income.hold, income.owner, firstKey, firstId]);
    expect((await db.query("select * from public.read_platform_hold_owner_funds($1)", [income.owner])).rows[0])
      .toEqual({ held_cents: "175", release_pending_cents: "0" });
    expect((await db.query("select status,stripe_transfer_id from public.platform_payment_holds where id=$1", [income.hold])).rows[0])
      .toEqual({ status: "classified_held", stripe_transfer_id: firstId });
    await expect(db.query("select public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)",
      [income.hold, income.owner, `transfer:${randomUUID()}`, "acct_owner", income.charge]))
      .rejects.toThrow(/no releasable residual/);
    // A terminal reconciliation may cancel the old creditor reservation;
    // its source history remains, and only the newly freed residual is sent.
    await db.query("update public.platform_source_consumption_legs set status='failed' where attempt_key=$1", [debtKey]);
    const refundPreview = await db.connect();
    try {
      await refundPreview.query("begin");
      const mixedKey = `refund:${randomUUID()}`;
      const quote = (await refundPreview.query("select (public.reserve_platform_money_refund($1,$2,1000,$3,null)).*",
        [income.owner, mixedKey, income.hold])).rows[0];
      expect(quote).toMatchObject({ held_cash_debit_cents: 175,
        transfer_reversal_cents: 825, hold_debit_cents: 1000 });
      const legs = (await refundPreview.query(`select source_transfer_id,amount_cents,
        component_breakdown from public.platform_hold_refund_transfer_legs
        where refund_attempt_id=$1`, [quote.id])).rows;
      expect(legs).toEqual([{ source_transfer_id: firstId, amount_cents: 825,
        component_breakdown: [{ source_id: income.source, recipient_net_cents: 825 }] }]);
      await refundPreview.query(`insert into public.ledger_entries
        (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,stripe_charge_id,posted_date)
        values($1,'payment','application_fee',1000,$2,$3,'2026-10-03')`,
      [income.owner, income.source, income.charge]);
      await refundPreview.query("select public.finish_platform_money_refund($1,$2,1000)",
        [mixedKey, `re_${randomUUID()}`]);
      const payerJournal = (await refundPreview.query("select public.book_platform_refund_component($1,$2,'2026-10-05T10:11:12Z') as id",
        [mixedKey, income.source])).rows[0].id;
      expect((await refundPreview.query(`select account_code,debit_cents,credit_cents
        from public.gl_journal_lines where journal_entry_id=$1 order by account_code`,
      [payerJournal])).rows).toEqual([
        { account_code: "accounts_payable", debit_cents: "0", credit_cents: "825" },
        { account_code: "application_fee", debit_cents: "1000", credit_cents: "0" },
        { account_code: "operating_cash", debit_cents: "0", credit_cents: "175" },
      ]);
      const reversal = `trr_${randomUUID()}`;
      const reversedAt = "2026-10-06T10:11:12Z";
      await refundPreview.query("savepoint early_recovery");
      await expect(refundPreview.query(`select public.book_platform_refund_transfer_recovery_component(
        $1,$2,$3)`, [mixedKey, reversal, income.source])).rejects.toThrow(/exact completed transfer leg/);
      await refundPreview.query("rollback to savepoint early_recovery");
      expect((await refundPreview.query(`select public.finish_platform_refund_transfer_leg(
        $1,$2,$3,825,$4) as changed`, [mixedKey, firstId, reversal, reversedAt])).rows[0].changed)
        .toBe(true);
      expect((await refundPreview.query(`select public.finish_platform_refund_transfer_leg(
        $1,$2,$3,825,$4) as changed`, [mixedKey, firstId, reversal, reversedAt])).rows[0].changed)
        .toBe(false);
      expect((await refundPreview.query("select amount_cents,status from public.platform_payment_holds where id=$1", [income.hold])).rows[0])
        .toEqual({ amount_cents: 0, status: "refunded" });
      const recoveryJournal = (await refundPreview.query(`select public.book_platform_refund_transfer_recovery_component(
        $1,$2,$3) as id`, [mixedKey, reversal, income.source])).rows[0].id;
      expect((await refundPreview.query(`select public.book_platform_refund_transfer_recovery_component(
        $1,$2,$3) as id`, [mixedKey, reversal, income.source])).rows[0].id).toBe(recoveryJournal);
      expect((await refundPreview.query(`select account_code,debit_cents,credit_cents
        from public.gl_journal_lines where journal_entry_id=$1 order by account_code`,
      [recoveryJournal])).rows).toEqual([
        { account_code: "accounts_payable", debit_cents: "825", credit_cents: "0" },
        { account_code: "operating_cash", debit_cents: "0", credit_cents: "825" },
      ]);
      await refundPreview.query("savepoint wrong_reversal");
      await expect(refundPreview.query(`select public.finish_platform_refund_transfer_leg(
        $1,$2,$3,825,$4)`, [mixedKey, firstId, `trr_${randomUUID()}`, reversedAt]))
        .rejects.toThrow(/replay changed provider leg/);
      await refundPreview.query("rollback to savepoint wrong_reversal");
    } finally {
      await refundPreview.query("rollback");
      refundPreview.release();
    }
    const secondKey = `transfer:${randomUUID()}`, secondId = `tr_${randomUUID()}`;
    const second = (await db.query("select (public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)).*",
      [income.hold, income.owner, secondKey, "acct_owner", income.charge])).rows[0];
    expect(second.amount_cents).toBe(175);
    await db.query("select public.finish_platform_hold_transfer($1,$2,$3,$4)",
      [income.hold, income.owner, secondKey, secondId]);
    expect((await db.query("select public.finish_platform_hold_transfer($1,$2,$3,$4) as changed",
      [income.hold, income.owner, firstKey, firstId])).rows[0].changed).toBe(false);
    expect((await db.query("select public.finish_platform_hold_transfer($1,$2,$3,$4) as changed",
      [income.hold, income.owner, secondKey, secondId])).rows[0].changed).toBe(false);
    await expect(db.query("select public.finish_platform_hold_transfer($1,$2,$3,$4)",
      [income.hold, income.owner, secondKey, firstId])).rejects.toThrow(/replay mismatch/);
    expect((await db.query("select status,stripe_transfer_id from public.platform_payment_holds where id=$1", [income.hold])).rows[0])
      .toEqual({ status: "transferred", stripe_transfer_id: firstId });
    expect((await db.query("select amount_cents,stripe_transfer_id from public.platform_hold_transfer_attempts where hold_id=$1 and status='created' order by amount_cents desc", [income.hold])).rows)
      .toEqual([{ amount_cents: 825, stripe_transfer_id: firstId },
        { amount_cents: 175, stripe_transfer_id: secondId }]);
    await db.query(`insert into public.ledger_entries
      (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,stripe_charge_id,posted_date)
      values($1,'payment','application_fee',1000,$2,$3,'2026-10-03')`,
    [income.owner, income.source, income.charge]);
    const fullKey = `refund:${randomUUID()}`, fullRefund = `re_${randomUUID()}`;
    const full = (await db.query("select (public.reserve_platform_money_refund($1,$2,1000,$3,null)).*",
      [income.owner, fullKey, income.hold])).rows[0];
    expect(full).toMatchObject({ held_cash_debit_cents: 0,
      transfer_reversal_cents: 1000, hold_debit_cents: 1000 });
    expect((await db.query(`select source_transfer_id,amount_cents from public.platform_hold_refund_transfer_legs
      where refund_attempt_id=$1 order by amount_cents desc`, [full.id])).rows)
      .toEqual([{ source_transfer_id: firstId, amount_cents: 825 },
        { source_transfer_id: secondId, amount_cents: 175 }]);
    await db.query("select public.finish_platform_money_refund($1,$2,1000)", [fullKey, fullRefund]);
    const payer = (await db.query("select public.book_platform_refund_component($1,$2,'2026-10-05T10:11:12Z') as id",
      [fullKey, income.source])).rows[0].id;
    expect((await db.query(`select account_code,debit_cents,credit_cents from public.gl_journal_lines
      where journal_entry_id=$1 order by account_code`, [payer])).rows).toEqual([
      { account_code: "accounts_payable", debit_cents: "0", credit_cents: "1000" },
      { account_code: "application_fee", debit_cents: "1000", credit_cents: "0" },
    ]);
    for (const [transferId, amount] of [[firstId, 825], [secondId, 175]] as const) {
      const reversal = `trr_${randomUUID()}`;
      await db.query("select public.finish_platform_refund_transfer_leg($1,$2,$3,$4,'2026-10-06T10:11:12Z')",
        [fullKey, transferId, reversal, amount]);
      const journal = (await db.query("select public.book_platform_refund_transfer_recovery_component($1,$2,$3) as id",
        [fullKey, reversal, income.source])).rows[0].id;
      expect((await db.query(`select account_code,debit_cents,credit_cents from public.gl_journal_lines
        where journal_entry_id=$1 order by account_code`, [journal])).rows).toEqual([
        { account_code: "accounts_payable", debit_cents: String(amount), credit_cents: "0" },
        { account_code: "operating_cash", debit_cents: "0", credit_cents: String(amount) },
      ]);
    }
    expect((await db.query("select amount_cents,status,stripe_transfer_id from public.platform_payment_holds where id=$1", [income.hold])).rows[0])
      .toEqual({ amount_cents: 0, status: "refunded", stripe_transfer_id: firstId });
  });

  it("keeps exhausted income AP separate from a positive deposit recovery in one captured cart", async () => {
    const owner = randomUUID(), income = randomUUID(), deposit = randomUUID();
    const charge = `ch_${randomUUID()}`, pi = `pi_${randomUUID()}`;
    const transfer = `tr_${randomUUID()}`, fee = `fee_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1)", [owner]);
    const components = JSON.stringify([
      { source_id: income, kind: "rent", liability_class: "income",
        principal_cents: 80, recipient_net_cents: 0 },
      { source_id: deposit, kind: "security_deposit", liability_class: "deposit",
        principal_cents: 20, recipient_net_cents: 20 },
    ]);
    const hold = (await db.query(`select * from public.credit_verified_platform_hold(
      $1,'manager','household_charge',$2,$3,$4,100,100,20,'manager',$5::jsonb,
      'acct_owned',$6,100,80,$7)`,
    [owner, `cart:${randomUUID()}`, charge, pi, components, transfer, fee])).rows[0].hold_id;
    for (const [source, category, principal] of [[income, "rent_income", 80],
      [deposit, "security_deposit_liability", 20]] as const) {
      await db.query(`insert into public.ledger_entries
        (manager_user_id,entry_type,category_code,amount_cents,source_charge_id,
         stripe_charge_id,property_id,posted_date)
        values($1,'payment',$2,$3,$4,$5,'property-cart-proof','2026-10-03')`,
      [owner, category, principal, source, charge]);
    }
    const key = `refund:${randomUUID()}`, refund = `re_${randomUUID()}`;
    const requested = JSON.stringify([
      { source_id: income, principal_cents: 80 },
      { source_id: deposit, principal_cents: 20 },
    ]);
    const reserved = (await db.query(`select (public.reserve_platform_money_refund(
      $1,$2,100,$3,null,p_components=>$4::jsonb)).*`,
    [owner, key, hold, requested])).rows[0];
    expect(reserved.recipient_debit_components).toEqual([
      { source_id: income, principal_cents: 80, recipient_debit_cents: 0,
        manager_debt_cents: 80 },
      { source_id: deposit, principal_cents: 20, recipient_debit_cents: 20,
        manager_debt_cents: 0 },
    ]);
    await db.query("select public.finish_platform_money_refund($1,$2,100)", [key, refund]);
    for (const source of [income, deposit]) {
      await db.query("select public.book_platform_refund_component($1,$2,'2026-10-04T10:11:12Z')",
        [key, source]);
    }
    const depositPayerJournal = (await db.query(`select j.id from public.gl_journal_entries j
      where j.source_type='refund' and j.source_id=$1`, [`refund:${deposit}:${refund}`])).rows[0].id;
    expect((await db.query(`select account_code,debit_cents,credit_cents
      from public.gl_journal_lines where journal_entry_id=$1 order by account_code`,
    [depositPayerJournal])).rows).toEqual([
      { account_code: "accounts_payable", debit_cents: "0", credit_cents: "20" },
      { account_code: "security_deposit_liability", debit_cents: "20", credit_cents: "0" },
    ]);
    expect((await db.query(`select source_charge_id,amount_cents from public.ledger_entries
      where entry_type='refund' and stripe_refund_id=$1 order by source_charge_id`, [refund])).rows)
      .toEqual([
        { source_charge_id: [income, deposit].sort()[0],
          amount_cents: String([income, deposit].sort()[0] === income ? 80 : 20) },
        { source_charge_id: [income, deposit].sort()[1],
          amount_cents: String([income, deposit].sort()[1] === income ? 80 : 20) },
      ]);
    const reversal = `trr_${randomUUID()}`;
    await db.query("select public.finish_platform_transfer_reversal($1,$2,$3,20)",
      [key, transfer, reversal]);
    const recovery = (await db.query("select public.book_platform_refund_recovery_component($1,$2,'2026-10-05T11:12:13Z') as id",
      [key, deposit])).rows[0].id;
    expect((await db.query(`select account_code,debit_cents,credit_cents from public.gl_journal_lines
      where journal_entry_id=$1 order by account_code`, [recovery])).rows).toEqual([
      { account_code: "accounts_payable", debit_cents: "20", credit_cents: "0" },
      { account_code: "trust_account_security_deposits", debit_cents: "0", credit_cents: "20" },
    ]);
    await expect(db.query("select public.book_platform_refund_recovery_component($1,$2,'2026-10-05T11:12:13Z')",
      [key, income])).rejects.toThrow(/net differs/);
    expect((await db.query("select funded_debt_cents from public.platform_hold_refund_attempts where attempt_key=$1", [key])).rows[0].funded_debt_cents)
      .toBe(80);
  });

  it("can refund remaining manager principal after net hold is already exhausted", async () => {
    const f = await managerHold(4825, 5000);
    await db.query("select public.verify_platform_hold_source($1,$2,$3,$4,5000,5000,4825,'manager',p_components=>$5::jsonb)",
      [f.hold, f.owner, f.charge, f.intent, JSON.stringify([{
        source_id: f.source, kind: "application_fee", liability_class: "income",
        principal_cents: 5000, recipient_net_cents: 4825,
      }])]);
    const firstKey = `refund:${randomUUID()}`;
    await db.query("select public.reserve_platform_money_refund($1,$2,4825,$3,null)", [f.owner, firstKey, f.hold]);
    await db.query("select public.finish_platform_money_refund($1,$2,4825)", [firstKey, `re_${randomUUID()}`]);
    expect((await db.query("select status,amount_cents from public.platform_payment_holds where id=$1", [f.hold])).rows[0])
      .toEqual({ status: "refunded", amount_cents: 0 });
    const secondKey = `refund:${randomUUID()}`;
    const second = (await db.query("select (public.reserve_platform_money_refund($1,$2,175,$3,null)).*",
      [f.owner, secondKey, f.hold])).rows[0];
    expect(second).toMatchObject({ hold_debit_cents: 0, manager_debt_cents: 175 });
    await db.query("select public.finish_platform_money_refund($1,$2,175)", [secondKey, `re_${randomUUID()}`]);
    expect((await db.query("select reversal_status,status from public.platform_hold_refund_attempts where attempt_key=$1", [secondKey])).rows[0])
      .toEqual({ reversal_status: "not_required", status: "succeeded" });
  });

  it("attests a ready destination as transferred source allocation, excluded from held money", async () => {
    const owner = randomUUID(), source = randomUUID();
    const charge = `ch_${source}`, intent = `pi_${source}`;
    const transfer = `tr_${source}`, applicationFee = `fee_${source}`;
    await db.query("insert into auth.users(id) values($1)", [owner]);
    const components = JSON.stringify([{ source_id: source, kind: "application_fee", liability_class: "income",
      principal_cents: 5000, recipient_net_cents: 4825 }]);
    const credit = async (destination: string) => db.query(`select * from public.credit_verified_platform_hold(
      $1,'manager','application_fee',$2,$3,$4,5000,5000,4825,'manager',$5::jsonb,$6,$7,5000,175,$8)`,
      [owner, source, charge, intent, components, destination, transfer, applicationFee]);
    const first = (await credit("acct_owned")).rows[0];
    const id = first.hold_id;
    expect(first.credited).toBe(true);
    expect((await credit("acct_owned")).rows[0]).toEqual({ hold_id: id, credited: false });
    await expect(credit("acct_foreign")).rejects.toThrow(/mismatch/);
    const { rows } = await db.query(`select status,source_allocation_mode,source_destination_account_id,
      source_transfer_gross_cents,source_application_fee_cents,source_application_fee_id
      from public.platform_payment_holds where id=$1`, [id]);
    expect(rows[0]).toMatchObject({ status: "transferred", source_allocation_mode: "destination",
      source_destination_account_id: "acct_owned", source_transfer_gross_cents: 5000,
      source_application_fee_cents: 175, source_application_fee_id: applicationFee });
    expect((await db.query("select coalesce(sum(amount_cents),0)::int as held from public.platform_payment_holds where owner_user_id=$1 and status='held'", [owner])).rows[0].held)
      .toBe(0);
  });

  it("does not debit a transferred vendor until the exact net reversal succeeds", async () => {
    const manager = randomUUID(), vendor = randomUUID(), invoice = randomUUID();
    const charge = `ch_${randomUUID()}`, pi = `pi_${randomUUID()}`;
    const transfer = `tr_${randomUUID()}`, fee = `fee_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1),($2)", [manager, vendor]);
    const components = JSON.stringify([{ source_id: invoice, kind: "vendor_invoice",
      liability_class: "vendor", principal_cents: 100, recipient_net_cents: 97 }]);
    const credited = (await db.query(`select * from public.credit_verified_platform_hold(
      $1,'vendor','vendor_invoice',$2,$3,$4,132,100,97,'manager',$5::jsonb,$6,$7,132,35,$8)`,
      [vendor, `direct:${invoice}`, charge, pi, components, "acct_vendor", transfer, fee])).rows[0];
    const payout = randomUUID();
    await db.query(`insert into public.vendor_payouts
      (id,manager_user_id,vendor_user_id,work_order_id,platform_hold_id,amount_cents,
       platform_fee_cents,status,stripe_charge_id)
      values($1,$2,$3,$4,$5,100,3,'paid',$6)`,
      [payout, manager, vendor, `service-${randomUUID()}`, credited.hold_id, charge]);
    const key1 = `refund:${randomUUID()}`;
    const first = (await db.query("select (public.reserve_platform_money_refund($1,$2,50,$3,$4)).*",
      [vendor, key1, credited.hold_id, payout])).rows[0];
    expect(first).toMatchObject({ fee_share_cents: 2, hold_debit_cents: 48,
      reverse_transfer: false, refund_application_fee: false });
    await db.query("select public.finish_platform_money_refund($1,$2,50)", [key1, `re_${randomUUID()}`]);
    expect((await db.query("select amount_cents,status from public.platform_payment_holds where id=$1", [credited.hold_id])).rows[0])
      .toEqual({ amount_cents: 97, status: "transferred" });
    await expect(db.query("select public.reserve_platform_money_refund($1,$2,50,$3,$4)",
      [vendor, `refund:${randomUUID()}`, credited.hold_id, payout])).rejects.toThrow(/reversal needs review/);
    const reversal1 = `trr_${randomUUID()}`;
    expect((await db.query("select public.finish_platform_transfer_reversal($1,$2,$3,48) as changed",
      [key1, transfer, reversal1])).rows[0].changed).toBe(true);
    expect((await db.query("select public.finish_platform_transfer_reversal($1,$2,$3,48) as changed",
      [key1, transfer, reversal1])).rows[0].changed).toBe(false);
    const key2 = `refund:${randomUUID()}`;
    const second = (await db.query("select (public.reserve_platform_money_refund($1,$2,50,$3,$4)).*",
      [vendor, key2, credited.hold_id, payout])).rows[0];
    expect(second).toMatchObject({ fee_share_cents: 1, hold_debit_cents: 49 });
    await db.query("select public.finish_platform_money_refund($1,$2,50)", [key2, `re_${randomUUID()}`]);
    await db.query("select public.finish_platform_transfer_reversal($1,$2,$3,49)",
      [key2, transfer, `trr_${randomUUID()}`]);
    expect((await db.query("select amount_cents,status from public.platform_payment_holds where id=$1", [credited.hold_id])).rows[0])
      .toEqual({ amount_cents: 0, status: "refunded" });
  });

  it("totals every held source and separates an unknown transfer reservation by owner", async () => {
    const pending = await managerHold();
    const other = await managerHold();
    await verifySource(pending);
    await db.query(`insert into public.platform_payment_holds
      (owner_user_id,owner_role,source,source_id,amount_cents,status)
      select $1,'manager','household_charge',$2||n::text,1,'held'
      from generate_series(1,1105) n`, [pending.owner, `many-${randomUUID()}-`]);
    const before = (await db.query("select * from public.read_platform_hold_owner_funds($1)", [pending.owner])).rows[0];
    expect(before).toEqual({ held_cents: "1205", release_pending_cents: "0" });
    await db.query("select public.reserve_platform_hold_transfer($1,$2,$3,$4,$5)",
      [pending.hold, pending.owner, `transfer:${randomUUID()}`, "acct_owner", pending.charge]);
    // Stripe may already have accepted this transfer while the DB stamp is
    // missing. It cannot still be advertised as held on top of Stripe funds.
    expect((await db.query("select * from public.read_platform_hold_owner_funds($1)", [pending.owner])).rows[0])
      .toEqual({ held_cents: "1105", release_pending_cents: "100" });
    expect((await db.query("select * from public.read_platform_hold_owner_funds($1)", [other.owner])).rows[0])
      .toEqual({ held_cents: "100", release_pending_cents: "0" });
  });

  it("exposes every new operation only to the service role", async () => {
    for (const signature of [
      "record_platform_source_refund_evidence(text,text,text,integer,text)",
      "platform_source_has_unmapped_refund(text)",
      "verify_platform_hold_source(uuid,uuid,text,text,integer,integer,integer,text,text,text,integer,integer,text,jsonb)",
      "credit_verified_platform_hold(uuid,text,text,text,text,text,integer,integer,integer,text,jsonb,text,text,integer,integer,text)",
      "credit_verified_platform_income_mirror(uuid,text,text,text,text,integer,integer,integer,text,jsonb,timestamptz)",
      "reserve_platform_hold_transfer(uuid,uuid,text,text,text)",
      "finish_platform_hold_transfer(uuid,uuid,text,text)",
      "read_platform_hold_owner_funds(uuid)",
      "platform_balance_move_from_sources(uuid,uuid,bigint,text,jsonb)",
      "reserve_platform_money_refund(uuid,text,integer,uuid,uuid,integer,text,boolean,boolean,jsonb)",
      "finish_platform_money_refund(text,text,integer)",
      "stamp_platform_pending_refund(text,text,text,integer)",
      "finish_platform_transfer_reversal(text,text,text,integer)",
      "finish_platform_refund_transfer_leg(text,text,text,integer,timestamp with time zone)",
      "fail_platform_money_refund(text,text,text,text,integer)",
      "book_platform_refund_component(text,text,timestamp with time zone)",
      "book_platform_refund_recovery_component(text,text,timestamp with time zone)",
      "book_platform_refund_transfer_recovery_component(text,text,text)",
      "platform_refund_accounting_complete(uuid)",
      "reserve_platform_owner_recovery(uuid,uuid,uuid,text,integer,text)",
      "settle_platform_owner_recovery(text,text,text,text,timestamp with time zone,timestamp with time zone)",
    ]) {
      for (const role of ["anon", "authenticated"]) {
        const { rows } = await db.query("select has_function_privilege($1,$2,'execute') as allowed", [role, `public.${signature}`]);
        expect(rows[0].allowed, `${role} must not call ${signature}`).toBe(false);
      }
      const { rows } = await db.query("select has_function_privilege('service_role',$1,'execute') as allowed", [`public.${signature}`]);
      expect(rows[0].allowed).toBe(true);
    }
    expect((await db.query("select to_regprocedure('public.fail_platform_hold_transfer(uuid,uuid,text)') as routine")).rows[0].routine)
      .toBeNull();
    for (const table of ["platform_hold_transfer_attempts", "platform_hold_refund_attempts",
      "platform_hold_refund_transfer_legs",
      "platform_source_refund_evidence", "platform_source_consumption_legs"]) {
      for (const role of ["anon", "authenticated"]) {
        const { rows } = await db.query("select has_table_privilege($1,$2,'select,insert,update,delete') as allowed", [role, `public.${table}`]);
        expect(rows[0].allowed).toBe(false);
      }
    }
  });
});
