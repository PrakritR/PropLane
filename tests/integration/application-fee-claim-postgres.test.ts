import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.PAYMENT_AUDIT_TEST_DATABASE_URL;
if (url && !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  throw new Error("Application fee claim proof requires disposable local PostgreSQL.");
}
const suite = url ? describe : describe.skip;
const db = new Pool({ connectionString: url, max: 6 });
const migration = readFileSync("supabase/migrations/20261004224000_application_fee_payment_claims.sql", "utf8");
const holdsMigration = readFileSync("supabase/migrations/20260923120000_platform_payment_holds.sql", "utf8");

async function draft(manager: string, email: string, suffix = randomUUID()) {
  const id = `app_${suffix}`, property = `property_${suffix}`, charge = `hc_app_${suffix}`;
  const row = { bucket: "pending", stage: "In progress", application: { propertyId: property, email } };
  const saved = await db.query(`insert into public.manager_application_records
    (id,manager_user_id,resident_email,property_id,row_data)
    values($1,$2,$3,$4,$5) returning updated_at::text as updated_at`, [id, manager, email, property, row]);
  await db.query("insert into public.manager_property_records(id,manager_user_id,property_data) values($1,$2,'{}')", [property, manager]);
  return { id, manager, email, property, charge, updatedAt: saved.rows[0].updated_at as string };
}

function params(f: Awaited<ReturnType<typeof draft>>) {
  return { mode: "embedded", applicationId: f.id, amountCents: 500, paymentMethod: "card" };
}

async function reserve(f: Awaited<ReturnType<typeof draft>>, policy: "first_only" | "every_time") {
  return db.query(`select * from public.reserve_application_fee_checkout(
    $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
  [f.id, f.manager, f.property, f.email, f.charge, 500, 44, 500, JSON.stringify(params(f)), f.updatedAt, policy]);
}

suite("application fee durable claim on local PostgreSQL", () => {
  beforeAll(async () => {
    await db.query(`
      create table if not exists public.manager_application_records (
        id text primary key, manager_user_id uuid, resident_email text, property_id text,
        row_data jsonb not null, updated_at timestamptz not null default now()
      );
      create table if not exists public.manager_property_records (
        id text primary key, manager_user_id uuid, property_data jsonb not null default '{}'
      );
      create table if not exists public.portal_household_charge_records (
        id text primary key, manager_user_id uuid, resident_email text,
        property_id text, kind text, status text, row_data jsonb not null,
        updated_at timestamptz not null default now()
      );
    `);
    await db.query(migration);
    await db.query(migration);
    await db.query(holdsMigration);
  });

  it("admits only one manager hold for simultaneous return and webhook replay of a paid session", async () => {
    const manager = randomUUID(), sourceId = `cs_${randomUUID()}`;
    await db.query("insert into auth.users(id) values($1)", [manager]);
    const first = await db.connect(), second = await db.connect();
    try {
      await first.query("begin");
      await first.query(`insert into public.platform_payment_holds
        (owner_user_id,owner_role,source,source_id,amount_cents,status,stripe_charge_id)
        values($1,'manager','application_fee',$2,5000,'held','ch_exact')`, [manager, sourceId]);
      const pid = (await second.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const competing = second.query(`insert into public.platform_payment_holds
        (owner_user_id,owner_role,source,source_id,amount_cents,status,stripe_charge_id)
        values($1,'manager','application_fee',$2,5000,'held','ch_exact')`, [manager, sourceId]);
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const activity = await db.query("select wait_event_type from pg_stat_activity where pid=$1", [pid]);
        if (activity.rows[0]?.wait_event_type === "Lock") { blocked = true; break; }
        await sleep(10);
      }
      expect(blocked).toBe(true);
      await first.query("commit");
      await expect(competing).rejects.toMatchObject({ code: "23505" });
      const saved = await db.query(`select owner_user_id,amount_cents,stripe_charge_id from public.platform_payment_holds
        where source='application_fee' and source_id=$1`, [sourceId]);
      expect(saved.rows).toEqual([{ owner_user_id: manager, amount_cents: 5000, stripe_charge_id: "ch_exact" }]);
    } finally {
      await first.query("rollback").catch(() => undefined);
      first.release(); second.release();
    }
  });
  afterAll(async () => { await db.end(); });

  it("grants each claim mutation only to service_role", async () => {
    for (const role of ["anon", "authenticated"]) {
      const table = await db.query("select has_table_privilege($1,'public.application_fee_payment_claims','select,insert,update,delete') as allowed", [role]);
      expect(table.rows[0].allowed).toBe(false);
    }
    for (const signature of [
      "reserve_application_fee_checkout(text,uuid,text,text,text,integer,integer,integer,jsonb,timestamptz,text)",
      "bind_application_fee_checkout_session(text,uuid,text)",
      "rotate_expired_application_fee_checkout(text,uuid,text,integer,integer,integer,jsonb,timestamptz,text)",
      "retire_expired_application_fee_checkout(text,uuid,text)",
      "settle_application_fee_checkout(text,uuid,text,text,jsonb)",
      "record_application_fee_promotion_result(text,text,text,text)",
    ]) {
      for (const role of ["anon", "authenticated"]) {
        const result = await db.query("select has_function_privilege($1,$2,'execute') as allowed", [role, `public.${signature}`]);
        expect(result.rows[0].allowed, signature).toBe(false);
      }
      const service = await db.query("select has_function_privilege('service_role',$1,'execute') as allowed", [`public.${signature}`]);
      expect(service.rows[0].allowed, signature).toBe(true);
    }
  });

  it("arbitrates two first-only drafts but permits every-time independent fees", async () => {
    const manager = randomUUID(), email = `app-${randomUUID()}@example.test`;
    await db.query("insert into auth.users(id) values($1)", [manager]);
    const a = await draft(manager, email), b = await draft(manager, email);
    const results = await Promise.allSettled([reserve(a, "first_only"), reserve(b, "first_only")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const c = await draft(manager, email), d = await draft(manager, email);
    await expect(reserve(c, "every_time")).resolves.toBeTruthy();
    await expect(reserve(d, "every_time")).resolves.toBeTruthy();
  });

  it("blocks a second first-only reserve until the first paid settlement commits", async () => {
    const manager = randomUUID(), email = `app-${randomUUID()}@example.test`;
    await db.query("insert into auth.users(id) values($1)", [manager]);
    const firstDraft = await draft(manager, email), secondDraft = await draft(manager, email);
    const claim = (await reserve(firstDraft, "first_only")).rows[0];
    const sessionId = `cs_${randomUUID()}`, chargeId = `ch_${randomUUID()}`;
    await db.query("select public.bind_application_fee_checkout_session($1,$2,$3)",
      [firstDraft.id, claim.attempt_token, sessionId]);
    const paid = { id: firstDraft.charge, applicationId: firstDraft.id, stripeCheckoutSessionId: sessionId,
      managerUserId: manager, propertyId: firstDraft.property, residentEmail: email,
      kind: "application_fee", status: "paid", amountLabel: "$5.00", stripePaymentStatus: "paid",
      paidAmountCents: 544, paidAt: "2026-10-04T03:00:00Z" };
    const settler = await db.connect(), reserver = await db.connect();
    try {
      await settler.query("begin");
      await settler.query("select public.settle_application_fee_checkout($1,$2,$3,$4,$5::jsonb)",
        [firstDraft.id, claim.attempt_token, sessionId, chargeId, JSON.stringify(paid)]);
      const pid = (await reserver.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const competing = reserver.query(`select * from public.reserve_application_fee_checkout(
        $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
      [secondDraft.id, manager, secondDraft.property, email, secondDraft.charge,
        500, 44, 500, JSON.stringify(params(secondDraft)), secondDraft.updatedAt, "first_only"])
        .then(() => ({ accepted: true }), (error: Error) => ({ accepted: false, error }));
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const activity = await db.query("select wait_event_type from pg_stat_activity where pid=$1", [pid]);
        if (activity.rows[0]?.wait_event_type === "Lock") { blocked = true; break; }
        await sleep(10);
      }
      expect(blocked).toBe(true);
      await settler.query("commit");
      const result = await competing;
      expect(result.accepted).toBe(false);
      expect(result.error?.message).toMatch(/already has a waived application fee/);
      const rows = await db.query(`select application_id,status from public.application_fee_payment_claims
        where manager_user_id=$1 and resident_email=$2`, [manager, email]);
      expect(rows.rows).toEqual([{ application_id: firstDraft.id, status: "settled" }]);
    } finally {
      await settler.query("rollback").catch(() => undefined);
      settler.release(); reserver.release();
    }
  });

  it("releases only the exact terminal attempt so another first-only draft may pay", async () => {
    const manager = randomUUID(), email = `app-${randomUUID()}@example.test`;
    await db.query("insert into auth.users(id) values($1)", [manager]);
    const a = await draft(manager, email), b = await draft(manager, email);
    const claim = (await reserve(a, "first_only")).rows[0];
    const sessionId = `cs_${randomUUID()}`;
    expect((await db.query("select public.bind_application_fee_checkout_session($1,$2,$3) bound",
      [a.id, claim.attempt_token, sessionId])).rows[0].bound).toBe(true);
    expect((await db.query("select public.retire_expired_application_fee_checkout($1,$2,$3) retired",
      [a.id, claim.attempt_token, `cs_${randomUUID()}`])).rows[0].retired).toBe(false);
    await expect(reserve(b, "first_only")).rejects.toThrow(/application_fee_one_pending/);
    expect((await db.query("select public.retire_expired_application_fee_checkout($1,$2,$3) retired",
      [a.id, claim.attempt_token, sessionId])).rows[0].retired).toBe(true);
    await expect(reserve(b, "first_only")).resolves.toBeTruthy();
    expect((await db.query("select status from public.application_fee_payment_claims where application_id=$1", [a.id])).rows[0].status).toBe("expired");
  });

  it("rotates an expired source only against the current saved draft and first-only policy", async () => {
    const manager = randomUUID(), email = `app-${randomUUID()}@example.test`;
    await db.query("insert into auth.users(id) values($1)", [manager]);
    const a = await draft(manager, email), b = await draft(manager, email);
    const claim = (await reserve(a, "first_only")).rows[0];
    const sessionId = `cs_${randomUUID()}`;
    await db.query("select public.bind_application_fee_checkout_session($1,$2,$3)", [a.id, claim.attempt_token, sessionId]);
    const updated = await db.query(`update public.manager_application_records
      set row_data=jsonb_set(row_data,'{application,roomChoice1}','"premium"'),
          updated_at=now()+interval '1 second' where id=$1 returning updated_at::text as value`, [a.id]);
    const rotate = (stamp: string) => db.query(`select * from public.rotate_expired_application_fee_checkout(
      $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [a.id, claim.attempt_token, sessionId, 700, 60, 700,
      JSON.stringify({ ...params(a), amountCents: 700, draftSelectors: "premium" }), stamp, "first_only"]);
    await expect(rotate(a.updatedAt)).rejects.toThrow(/cannot rotate/);
    const next = (await rotate(updated.rows[0].value)).rows[0];
    expect(next.attempt_token).not.toBe(claim.attempt_token);
    expect(next.principal_cents).toBe(700);
    await db.query("update public.manager_application_records set row_data=jsonb_set(row_data,'{stage}','\"Submitted\"') where id=$1", [b.id]);
    const secondSession = `cs_${randomUUID()}`;
    await db.query("select public.bind_application_fee_checkout_session($1,$2,$3)", [a.id, next.attempt_token, secondSession]);
    await expect(db.query(`select public.rotate_expired_application_fee_checkout(
      $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [a.id, next.attempt_token, secondSession, 700, 60, 700,
      JSON.stringify(params(a)), updated.rows[0].value, "first_only"])).rejects.toThrow(/waived/);
  });

  it("rejects changed, waived, or submitted draft before claim", async () => {
    const manager = randomUUID(), email = `app-${randomUUID()}@example.test`;
    await db.query("insert into auth.users(id) values($1)", [manager]);
    const stale = await draft(manager, email);
    await db.query("update public.manager_application_records set updated_at=now()+interval '1 second' where id=$1", [stale.id]);
    await expect(reserve(stale, "every_time")).rejects.toThrow(/draft changed/);
    const waived = await draft(manager, email);
    await db.query("update public.manager_application_records set row_data=jsonb_set(row_data,'{application,applicationFeeWaived}','true') where id=$1", [waived.id]);
    await expect(reserve(waived, "every_time")).rejects.toThrow(/no longer requires/);
    const submitted = await draft(manager, email);
    await db.query("update public.manager_application_records set row_data=jsonb_set(row_data,'{stage}','\"Submitted\"') where id=$1", [submitted.id]);
    await expect(reserve(submitted, "every_time")).rejects.toThrow(/no longer requires/);
    const withdrawn = await draft(manager, email);
    await db.query("update public.manager_application_records set row_data=jsonb_set(row_data,'{withdrawnAt}','\"2026-10-04T12:00:00Z\"') where id=$1", [withdrawn.id]);
    await expect(reserve(withdrawn, "every_time")).rejects.toThrow(/no longer requires/);
    const moved = await draft(manager, email);
    await db.query("update public.manager_property_records set manager_user_id=$1 where id=$2", [randomUUID(), moved.property]);
    await expect(reserve(moved, "every_time")).rejects.toThrow(/listing owner changed/);
  });

  it("does not treat a withdrawn prior application as a first-only fee payment", async () => {
    const manager = randomUUID(), email = `app-${randomUUID()}@example.test`;
    await db.query("insert into auth.users(id) values($1)", [manager]);
    const prior = await draft(manager, email);
    await db.query(`update public.manager_application_records set row_data=row_data ||
      '{"bucket":"submitted","stage":"Submitted","withdrawnAt":"2026-10-04T12:00:00Z"}'::jsonb where id=$1`, [prior.id]);
    const current = await draft(manager, email);
    await expect(reserve(current, "first_only")).resolves.toBeTruthy();
  });

  it("binds the exact paid session and replays without changing captured time", async () => {
    const manager = randomUUID(), email = `app-${randomUUID()}@example.test`;
    await db.query("insert into auth.users(id) values($1)", [manager]);
    const f = await draft(manager, email);
    const claim = (await reserve(f, "every_time")).rows[0];
    const sessionId = `cs_${randomUUID()}`, chargeId = `ch_${randomUUID()}`;
    const paidAt = "2026-01-02T03:04:05.000Z";
    const row = { id: f.charge, applicationId: f.id, stripeCheckoutSessionId: sessionId, managerUserId: manager,
      propertyId: f.property, residentEmail: email, kind: "application_fee", status: "paid",
      amountLabel: "$5.00", stripePaymentStatus: "paid", paidAmountCents: 544, paidAt };
    await expect(db.query("select public.settle_application_fee_checkout($1,$2,$3,$4,$5::jsonb)",
      [f.id, claim.attempt_token, "cs_wrong", chargeId, JSON.stringify(row)])).rejects.toThrow(/does not match/);
    await db.query("select public.bind_application_fee_checkout_session($1,$2,$3)", [f.id, claim.attempt_token, sessionId]);
    await db.query("select public.settle_application_fee_checkout($1,$2,$3,$4,$5::jsonb)",
      [f.id, claim.attempt_token, sessionId, chargeId, JSON.stringify(row)]);
    await db.query("update public.portal_household_charge_records set status='refunded' where id=$1", [f.charge]);
    await db.query("select public.settle_application_fee_checkout($1,$2,$3,$4,$5::jsonb)",
      [f.id, claim.attempt_token, sessionId, chargeId, JSON.stringify(row)]);
    await db.query("select public.settle_application_fee_checkout($1,$2,$3,$4,$5::jsonb)",
      [f.id, claim.attempt_token, sessionId, chargeId, JSON.stringify(row)]);
    expect((await db.query("select count(*)::int n from public.portal_household_charge_records where id=$1", [f.charge])).rows[0].n).toBe(1);
    expect((await db.query("select row_data->>'paidAt' paid_at from public.portal_household_charge_records where id=$1", [f.charge])).rows[0].paid_at).toBe(paidAt);
    expect((await db.query("select status from public.portal_household_charge_records where id=$1", [f.charge])).rows[0].status).toBe("refunded");
    await db.query("update public.portal_household_charge_records set row_data=jsonb_set(row_data,'{amountLabel}','\"$7.00\"') where id=$1", [f.charge]);
    await expect(db.query("select public.settle_application_fee_checkout($1,$2,$3,$4,$5::jsonb)",
      [f.id, claim.attempt_token, sessionId, chargeId, JSON.stringify(row)])).rejects.toThrow(/changed on replay/);
  });
});
