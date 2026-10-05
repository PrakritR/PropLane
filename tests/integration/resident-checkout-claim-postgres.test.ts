import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.PAYMENT_AUDIT_TEST_DATABASE_URL;
if (url && !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  throw new Error("Resident claim proof requires disposable local PostgreSQL.");
}
const suite = url ? describe : describe.skip;
const db = new Pool({ connectionString: url, max: 8 });
const migration = readFileSync("supabase/migrations/20261004230000_resident_checkout_attempt_claims.sql", "utf8");

async function household(count: number) {
  const manager = randomUUID(), resident = randomUUID();
  const email = `resident-${resident}@example.test`;
  const property = `property_${randomUUID()}`;
  await db.query("insert into auth.users(id,email) values($1,$2),($3,$4)",
    [manager, `manager-${manager}@example.test`, resident, email]);
  await db.query("insert into manager_property_records(id,manager_user_id,status,row_data) values($1,$2,'live','{}')",
    [property, manager]);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `hc_${randomUUID()}`;
    const row = { id, managerUserId: manager, residentUserId: resident,
      residentEmail: email, propertyId: property, kind: "rent", status: "pending",
      amountLabel: "$10.00", balanceLabel: "$10.00" };
    await db.query(`insert into portal_household_charge_records
      (id,manager_user_id,resident_user_id,resident_email,property_id,kind,status,row_data)
      values($1,$2,$3,$4,$5,'rent','pending',$6)`,
    [id, manager, resident, email, property, row]);
    ids.push(id);
  }
  return { manager, resident, email, property, ids };
}

type Home = Awaited<ReturnType<typeof household>>;
async function reserve(home: Home, ids: string[], method: "ach" | "card" = "card") {
  const token = randomUUID();
  const sorted = [...ids].sort();
  const subtotal = 1000 * sorted.length;
  const terms = { residentEmail: home.email, paymentMethod: method,
    lineItems: sorted.map(id => ({ id, amountCents: 1000 })),
    metadata: { resident_attempt_token: token, manager_user_id: home.manager, charge_ids: sorted.join(","),
      ...(method === "ach" ? { resident_payment_flow: "manual_ach", manual_ach: "1" } : {}) } };
  const result = await db.query(`select * from reserve_resident_checkout_attempt(
    $1,$2,$3,$4,$5::text[],$6::integer[],$7,$8,$9,$10,$11::jsonb)`,
  [token, home.resident, home.email, home.manager, sorted, sorted.map(() => 1000),
    subtotal, subtotal, subtotal, method, JSON.stringify(terms)]);
  return result.rows[0] as { id: string; attempt_token: string; stripe_session_id: string | null; status: string };
}

suite("resident checkout cart arbitration on local PostgreSQL", () => {
  beforeAll(async () => {
    // Minimal disposable schema used by this SQL arbitration suite. The real
    // account guard is separately applied and exercised by retention tests.
    await db.query(`do $fixture$ begin
      if to_regprocedure('public.account_guard_deleted_financial_identity()') is null then
        execute 'create function public.account_guard_deleted_financial_identity() returns trigger language plpgsql as $body$ begin return new; end $body$';
      end if;
    end $fixture$`);
    // The disposable schema fixture predates the later retry columns.
    await db.query("alter table public.resident_autopay_runs add column if not exists attempt integer not null default 1");
    await db.query("alter table public.resident_autopay_runs add column if not exists failure_reason text");
    await db.query(migration);
    await db.query(migration);
  });
  afterAll(async () => { await db.end(); });

  it("keeps the whole-cart winner for overlapping [A,B] and [B,C]", async () => {
    const home = await household(3);
    const [a, b, c] = home.ids;
    const outcomes = await Promise.allSettled([reserve(home, [a!, b!]), reserve(home, [b!, c!])]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const slots = (await db.query("select charge_id from resident_charge_payment_slots where charge_id=any($1::text[])",
      [home.ids])).rows.map(row => row.charge_id as string).sort();
    expect(slots).toHaveLength(2);
    expect(slots).toEqual(outcomes[0]!.status === "fulfilled" ? [a!, b!].sort() : [b!, c!].sort());
    const attempts = await db.query("select charge_ids from resident_checkout_attempts where resident_user_id=$1", [home.resident]);
    expect(attempts.rows).toHaveLength(1);
  });

  it("reuses an identical cart but rejects another method or a partial overlap", async () => {
    const home = await household(2);
    const first = await reserve(home, home.ids);
    const retry = await reserve(home, [...home.ids].reverse());
    expect(retry.id).toBe(first.id);
    expect(retry.attempt_token).toBe(first.attempt_token);
    await expect(reserve(home, home.ids, "ach")).rejects.toThrow(/different payment attempt/);
    await expect(reserve(home, [home.ids[0]!])).rejects.toThrow(/different payment attempt/);
  });

  it("holds the original attempt when the charge amount changes before an unresolved retry", async () => {
    const home = await household(1);
    const first = await reserve(home, home.ids);
    await db.query(`update portal_household_charge_records
      set row_data=jsonb_set(row_data,'{balanceLabel}','"$12.00"') where id=$1`, [home.ids[0]]);
    const token = randomUUID();
    const changed = { residentEmail: home.email, paymentMethod: "card",
      lineItems: [{ id: home.ids[0], amountCents: 1200 }],
      metadata: { resident_attempt_token: token, manager_user_id: home.manager, charge_ids: home.ids[0] } };
    await expect(db.query(`select * from reserve_resident_checkout_attempt(
      $1,$2,$3,$4,$5::text[],$6::integer[],$7,$8,$9,'card',$10::jsonb)`,
    [token, home.resident, home.email, home.manager, home.ids, [1200], 1200, 1200, 1200,
      JSON.stringify(changed)])).rejects.toThrow(/different payment attempt/);
    const saved = await db.query("select id,charge_cents,status from resident_checkout_attempts where id=$1", [first.id]);
    expect(saved.rows).toEqual([{ id: first.id, charge_cents: [1000], status: "pending" }]);
    expect((await db.query("select checkout_attempt_id from resident_charge_payment_slots where charge_id=$1",
      [home.ids[0]])).rows[0].checkout_attempt_id).toBe(first.id);
  });

  it("rejects a partially paid charge directly in either claim path", async () => {
    const home = await household(1);
    await db.query("update portal_household_charge_records set status='partially_paid', " +
      "row_data=jsonb_set(row_data,'{status}',to_jsonb('partially_paid'::text)) where id=$1", [home.ids[0]]);
    await expect(reserve(home, home.ids)).rejects.toThrow(/changed before checkout/);
    const runId = randomUUID();
    await db.query("insert into resident_autopay_runs(id,charge_id,resident_user_id,manager_id,status) " +
      "values($1,$2,$3,$4,'claimed')", [runId, home.ids[0], home.resident, home.manager]);
    expect((await db.query("select reserve_resident_autopay_slot($1,1) as reserved", [runId])).rows[0].reserved).toBe(false);
    expect((await db.query("select count(*)::integer as n from resident_charge_payment_slots where charge_id=$1",
      [home.ids[0]])).rows[0].n).toBe(0);
  });

  it("rejects a legacy charge with a stored source but no new claim slot", async () => {
    const home = await household(1);
    await db.query("update portal_household_charge_records set row_data=" +
      "jsonb_set(row_data,'{stripeCheckoutSessionId}',to_jsonb('cs_legacy_open'::text)) where id=$1", [home.ids[0]]);
    await expect(reserve(home, home.ids)).rejects.toThrow(/Existing checkout source needs payment review/);
    expect((await db.query("select count(*)::integer as n from resident_charge_payment_slots where charge_id=$1",
      [home.ids[0]])).rows[0].n).toBe(0);
  });

  it("arbitrates autopay against Checkout and settles its exact PI once", async () => {
    const home = await household(1);
    const runId = randomUUID(), piId = "pi_" + randomUUID();
    await db.query("insert into resident_autopay_runs(id,charge_id,resident_user_id,manager_id,status) " +
      "values($1,$2,$3,$4,'claimed')", [runId, home.ids[0], home.resident, home.manager]);
    expect((await db.query("select reserve_resident_autopay_slot($1,1) as reserved", [runId])).rows[0].reserved).toBe(true);
    expect((await db.query("select reserve_resident_autopay_slot($1,1) as reserved", [runId])).rows[0].reserved).toBe(false);
    await expect(reserve(home, home.ids)).rejects.toThrow(/owns this charge|Another payment/);
    expect((await db.query("select bind_resident_autopay_payment_intent($1,1,$2) as bound",
      [runId, piId])).rows[0].bound).toBe(true);
    expect((await db.query("select bind_resident_autopay_payment_intent($1,1,$2) as bound",
      [runId, "pi_other"])).rows[0].bound).toBe(false);
    const first = (await db.query("select settle_resident_autopay_run($1,1,$2,1000,$3) as result",
      [runId, piId, home.email])).rows[0].result;
    expect(first.newlySettled).toBe(true);
    expect(first.row).toMatchObject({ id: home.ids[0], status: "paid",
      paidAmountCents: 1000, stripeCheckoutSessionId: piId, balanceLabel: "$0.00" });
    const replay = (await db.query("select settle_resident_autopay_run($1,1,$2,1000,$3) as result",
      [runId, piId, home.email])).rows[0].result;
    expect(replay).toEqual({ row: first.row, newlySettled: false });
    await expect(db.query("select settle_resident_autopay_run($1,1,$2,1000,$3)",
      [runId, "pi_other", home.email])).rejects.toThrow(/changed before settlement/);
    expect((await db.query("select status,stripe_payment_intent_id from resident_autopay_runs where id=$1",
      [runId])).rows[0]).toEqual({ status: "succeeded", stripe_payment_intent_id: piId });
  });

  it("rejects a late PI event from the prior autopay attempt after retry reclaims the slot", async () => {
    const home = await household(1);
    const runId = randomUUID();
    await db.query("insert into resident_autopay_runs(id,charge_id,resident_user_id,manager_id,status) " +
      "values($1,$2,$3,$4,'claimed')", [runId, home.ids[0], home.resident, home.manager]);
    expect((await db.query("select reserve_resident_autopay_slot($1,1) as reserved",
      [runId])).rows[0].reserved).toBe(true);
    expect((await db.query("select bind_resident_autopay_payment_intent($1,1,'pi_old') as bound",
      [runId])).rows[0].bound).toBe(true);
    await db.query("update resident_autopay_runs set status='failed' where id=$1", [runId]);
    expect((await db.query("select release_resident_autopay_slot($1,1,'pi_old') as released",
      [runId])).rows[0].released).toBe(true);
    await db.query("update resident_autopay_runs set status='claimed',attempt=2," +
      "stripe_payment_intent_id=null where id=$1", [runId]);
    expect((await db.query("select reserve_resident_autopay_slot($1,2) as reserved",
      [runId])).rows[0].reserved).toBe(true);
    expect((await db.query("select bind_resident_autopay_payment_intent($1,1,'pi_old') as bound",
      [runId])).rows[0].bound).toBe(false);
    await expect(db.query("select settle_resident_autopay_run($1,1,'pi_old',1000,$2)",
      [runId, home.email])).rejects.toThrow(/changed before settlement/);
    const stored = await db.query("select status,stripe_payment_intent_id,attempt from resident_autopay_runs where id=$1",
      [runId]);
    expect(stored.rows[0]).toEqual({ status: "claimed", stripe_payment_intent_id: null, attempt: 2 });
    expect((await db.query("select status from portal_household_charge_records where id=$1",
      [home.ids[0]])).rows[0].status).toBe("pending");
  });

  it("holds manual ACH PI through verification, settles exact principal once, and never releases on failure", async () => {
    const home = await household(2);
    const claim = await reserve(home, home.ids, "ach");
    const session = `pi_${randomUUID()}`;
    expect((await db.query("select bind_resident_checkout_session($1,$2,$3) as bound",
      [claim.id, claim.attempt_token, `cs_${randomUUID()}`])).rows[0].bound).toBe(false);
    expect((await db.query("select bind_resident_checkout_session($1,$2,$3) as bound",
      [claim.id, claim.attempt_token, session])).rows[0].bound).toBe(true);
    expect((await db.query("select mark_resident_checkout_processing($1,$2,$3) as marked",
      [claim.id, claim.attempt_token, session])).rows[0].marked).toBe(2);
    expect((await reserve(home, home.ids, "ach")).id).toBe(claim.id);
    expect((await db.query("select retire_resident_checkout_attempt($1,$2,$3,'failed') as retired",
      [claim.id, claim.attempt_token, `cs_${randomUUID()}`])).rows[0].retired).toBe(false);
    expect((await db.query("select retire_resident_checkout_attempt($1,$2,$3,'failed') as retired",
      [claim.id, claim.attempt_token, session])).rows[0].retired).toBe(false);
    const intent = session;
    const settled = (await db.query("select settle_resident_checkout_attempt($1,$2,$3,$4) as result",
      [claim.id, claim.attempt_token, session, intent])).rows[0].result as { rows: Array<Record<string, unknown>>; newlySettled: boolean };
    expect(settled.newlySettled).toBe(true);
    const paid = settled.rows;
    expect(paid).toHaveLength(2);
    expect(paid.map(row => row.paidAmountCents)).toEqual([1000, 1000]);
    expect(paid.every(row => row.status === "paid" && row.balanceLabel === "$0.00")).toBe(true);
    const replay = (await db.query("select settle_resident_checkout_attempt($1,$2,$3,$4) as result",
      [claim.id, claim.attempt_token, session, intent])).rows[0].result;
    expect(replay).toEqual({ rows: paid, newlySettled: false });
    expect((await db.query("select retire_resident_checkout_attempt($1,$2,$3,'failed') as retired",
      [claim.id, claim.attempt_token, session])).rows[0].retired).toBe(false);
  });

  it("releases only the exact failed session and resets matching processing rows", async () => {
    const home = await household(1);
    const first = await reserve(home, home.ids, "card");
    const firstSession = `cs_${randomUUID()}`;
    await db.query("select bind_resident_checkout_session($1,$2,$3)", [first.id, first.attempt_token, firstSession]);
    await db.query("select mark_resident_checkout_processing($1,$2,$3)", [first.id, first.attempt_token, firstSession]);
    expect((await db.query("select retire_resident_checkout_attempt($1,$2,$3,'failed') as retired",
      [first.id, first.attempt_token, firstSession])).rows[0].retired).toBe(true);
    const charge = (await db.query("select status,row_data from portal_household_charge_records where id=$1", [home.ids[0]])).rows[0];
    expect(charge.status).toBe("pending");
    expect(charge.row_data.stripeCheckoutSessionId).toBeUndefined();
    const next = await reserve(home, home.ids);
    expect(next.id).not.toBe(first.id);
    expect((await db.query("select retire_resident_checkout_attempt($1,$2,$3,'failed') as retired",
      [first.id, first.attempt_token, firstSession])).rows[0].retired).toBe(false);
    expect((await db.query("select checkout_attempt_id from resident_charge_payment_slots where charge_id=$1",
      [home.ids[0]])).rows[0].checkout_attempt_id).toBe(next.id);
  });

  it("arbitrates manual Checkout against off-session autopay in the same slot", async () => {
    const manualFirst = await household(1);
    await reserve(manualFirst, manualFirst.ids);
    const runA = randomUUID();
    await db.query(`insert into resident_autopay_runs(id,charge_id,resident_user_id,manager_id,status)
      values($1,$2,$3,$4,'claimed')`,
    [runA, manualFirst.ids[0], manualFirst.resident, manualFirst.manager]);
    expect((await db.query("select reserve_resident_autopay_slot($1,1) as reserved", [runA])).rows[0].reserved).toBe(false);

    const autopayFirst = await household(1);
    const runB = randomUUID();
    await db.query(`insert into resident_autopay_runs(id,charge_id,resident_user_id,manager_id,status)
      values($1,$2,$3,$4,'claimed')`,
    [runB, autopayFirst.ids[0], autopayFirst.resident, autopayFirst.manager]);
    expect((await db.query("select reserve_resident_autopay_slot($1,1) as reserved", [runB])).rows[0].reserved).toBe(true);
    expect((await db.query("select reserve_resident_autopay_slot($1,1) as reserved", [runB])).rows[0].reserved).toBe(false);
    await expect(reserve(autopayFirst, autopayFirst.ids)).rejects.toThrow(/Autopay already owns/);
    expect((await db.query("select release_resident_autopay_slot($1,1,$2) as released",
      [runB, `pi_${randomUUID()}`])).rows[0].released).toBe(false);
    const failedPi = `pi_${randomUUID()}`;
    await db.query("update resident_autopay_runs set status='failed',stripe_payment_intent_id=$2 where id=$1",
      [runB, failedPi]);
    expect((await db.query("select release_resident_autopay_slot($1,1,$2) as released",
      [runB, `pi_${randomUUID()}`])).rows[0].released).toBe(false);
    expect((await db.query("select release_resident_autopay_slot($1,1,$2) as released",
      [runB, failedPi])).rows[0].released).toBe(true);
    expect((await reserve(autopayFirst, autopayFirst.ids)).status).toBe("pending");
  });
});
