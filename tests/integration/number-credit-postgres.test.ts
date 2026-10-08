import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Dedicated disposable local PostgreSQL only. The suite stubs `auth`, loads the real migration, and
// asserts the SQL contract of PropLane Number: subscription event ordering, monthly included credit
// spent first, purchased credit that never expires, refusal when empty, owner isolation, replay safety.
const url = process.env.NUMBER_CREDIT_TEST_DATABASE_URL;
if (url && !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  throw new Error("Number credit tests require a disposable local database.");
}
const db = new Pool({ connectionString: url, max: 12 });
afterAll(() => db.end());
const suite = url ? describe : describe.skip;

const INCLUDED = 300;

async function user(): Promise<string> {
  const id = randomUUID();
  await db.query("insert into auth.users(id) values($1)", [id]);
  return id;
}
async function activate(owner: string, role = "vendor", subscription = `sub_${randomUUID()}`, at = new Date()) {
  return (
    await db.query("select apply_number_subscription_event($1,$2,$3,$4,'active',now() + interval '30 days',false,$5) as r", [
      owner,
      role,
      `cus_${owner}`,
      subscription,
      at.toISOString(),
    ])
  ).rows[0].r as string;
}
async function reserve(owner: string, key = randomUUID(), quantity = 1, meter = "sms_outbound_segment", unit = 3, unfunded = false) {
  return (
    await db.query("select reserve_number_credit($1,$2,$3,$4,$5,$6,'{}',$7) as r", [owner, key, meter, quantity, unit, INCLUDED, unfunded])
  ).rows[0].r as { allowed: boolean; duplicate?: boolean; reason?: string; state?: string };
}
async function snap(owner: string) {
  return (await db.query("select number_credit_snapshot($1,$2,false) as r", [owner, INCLUDED])).rows[0].r as {
    included_remaining_cents: number;
    purchased_cents: number;
    subscription_status: string | null;
  };
}
async function addPurchased(owner: string, cents: number) {
  await db.query("insert into number_credit_accounts(owner_user_id) values($1) on conflict do nothing", [owner]);
  await db.query("update number_credit_accounts set purchased_credit_cents = purchased_credit_cents + $2 where owner_user_id=$1", [owner, cents]);
}

suite("PropLane Number ledger (real PostgreSQL)", () => {
  beforeAll(async () => {
    // Idempotency keys are global, so every run starts from empty tables in this disposable database.
    await db.query(
      "drop table if exists number_credit_adjustments, number_credit_purchases, number_credit_usage_events, number_credit_accounts, number_subscriptions cascade",
    );
    await db.query(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
      end $$;
      create schema if not exists auth;
      create table if not exists auth.users (id uuid primary key);
      create or replace function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
      grant usage on schema auth to authenticated, anon, service_role;
      grant execute on function auth.uid() to authenticated, anon;
    `);
    await db.query(readFileSync(path.join(process.cwd(), "supabase", "migrations", "20261008200000_number_subscriptions.sql"), "utf8"));
    // Applying the migration twice must be a no-op.
    await db.query(readFileSync(path.join(process.cwd(), "supabase", "migrations", "20261008200000_number_subscriptions.sql"), "utf8"));
  });

  it("client roles read only their own non-secret subscription columns and can never write", async () => {
    const a = await user();
    const b = await user();
    await activate(a);
    await activate(b, "resident");
    const client = await db.connect();
    try {
      await client.query("set role authenticated");
      await client.query("select set_config('app.uid', $1, false)", [a]);
      const own = await client.query("select owner_user_id, status from number_subscriptions");
      expect(own.rows.map((r) => r.owner_user_id)).toEqual([a]);
      await expect(client.query("select stripe_customer_id from number_subscriptions")).rejects.toThrow(/permission denied/);
      await expect(client.query("update number_subscriptions set status='active'")).rejects.toThrow(/permission denied/);
      await expect(client.query("insert into number_subscriptions(owner_user_id, owner_role) values (gen_random_uuid(),'vendor')")).rejects.toThrow(/permission denied/);
      for (const table of ["number_credit_accounts", "number_credit_usage_events", "number_credit_purchases", "number_credit_adjustments"]) {
        await expect(client.query(`select * from ${table}`)).rejects.toThrow(/permission denied/);
      }
      await expect(client.query("select reserve_number_credit($1,'k','sms_outbound_segment',1,3,300,'{}',true)", [a])).rejects.toThrow(/permission denied/);
    } finally {
      await client.query("reset role");
      client.release();
    }
  });

  it("applies subscription events once: replay is idempotent, an older event is stale, a live subscription is never replaced", async () => {
    const owner = await user();
    const sub = `sub_${randomUUID()}`;
    const t0 = new Date();
    expect(await activate(owner, "vendor", sub, t0)).toBe("applied");
    expect(await activate(owner, "vendor", sub, t0)).toBe("applied");
    const older = (
      await db.query("select apply_number_subscription_event($1,'vendor',$2,$3,'canceled',null,false,$4) as r", [
        owner,
        `cus_${owner}`,
        sub,
        new Date(t0.getTime() - 60_000).toISOString(),
      ])
    ).rows[0].r;
    expect(older).toBe("stale");
    expect((await snap(owner)).subscription_status).toBe("active");
    const other = (
      await db.query("select apply_number_subscription_event($1,'vendor',$2,'sub_other','active',null,false,$3) as r", [
        owner,
        `cus_${owner}`,
        new Date(t0.getTime() + 1000).toISOString(),
      ])
    ).rows[0].r;
    expect(other).toBe("other_subscription");
    const mismatch = (
      await db.query("select apply_number_subscription_event($1,'vendor','cus_attacker',$2,'active',null,false,$3) as r", [
        owner,
        sub,
        new Date(t0.getTime() + 2000).toISOString(),
      ])
    ).rows[0].r;
    expect(mismatch).toBe("customer_mismatch");
    const cancel = (
      await db.query("select apply_number_subscription_event($1,'vendor',$2,$3,'canceled',null,false,$4) as r", [
        owner,
        `cus_${owner}`,
        sub,
        new Date(t0.getTime() + 3000).toISOString(),
      ])
    ).rows[0].r;
    expect(cancel).toBe("applied");
    expect((await snap(owner)).subscription_status).toBe("canceled");
  });

  it("grants $3.00 on first use, spends included credit before purchased, and refuses when empty", async () => {
    const owner = await user();
    await activate(owner);
    await addPurchased(owner, 1000);
    expect(await snap(owner)).toMatchObject({ included_remaining_cents: 300, purchased_cents: 1000 });
    expect((await reserve(owner, "a", 50)).allowed).toBe(true); // 150c
    expect(await snap(owner)).toMatchObject({ included_remaining_cents: 150, purchased_cents: 1000 });
    expect((await reserve(owner, "b", 100)).allowed).toBe(true); // 300c: 150 included + 150 purchased
    expect(await snap(owner)).toMatchObject({ included_remaining_cents: 0, purchased_cents: 850 });
    const empty = await reserve(owner, "c", 400); // 1200c > 850
    expect(empty).toMatchObject({ allowed: false, reason: "allowance_exhausted" });
    expect(await snap(owner)).toMatchObject({ included_remaining_cents: 0, purchased_cents: 850 });
  });

  it("a reservation replay never debits twice and a changed replay is refused", async () => {
    const owner = await user();
    await activate(owner);
    expect((await reserve(owner, "k", 10)).duplicate).toBe(false);
    expect((await reserve(owner, "k", 10)).duplicate).toBe(true);
    expect((await snap(owner)).included_remaining_cents).toBe(270);
    await expect(reserve(owner, "k", 11)).rejects.toThrow(/identity mismatch/);
  });

  it("release returns credit to the buckets it came from, once", async () => {
    const owner = await user();
    await activate(owner);
    await addPurchased(owner, 500);
    await reserve(owner, "r", 120); // 360c: 300 included + 60 purchased
    expect(await snap(owner)).toMatchObject({ included_remaining_cents: 0, purchased_cents: 440 });
    expect((await db.query("select finish_number_credit($1,'r',true) as r", [owner])).rows[0].r).toBe(true);
    expect((await db.query("select finish_number_credit($1,'r',true) as r", [owner])).rows[0].r).toBe(true);
    expect(await snap(owner)).toMatchObject({ included_remaining_cents: 300, purchased_cents: 500 });
  });

  it("settle refunds the unused part, purchased first", async () => {
    const owner = await user();
    await activate(owner);
    await addPurchased(owner, 500);
    await reserve(owner, "s", 120); // 300 included + 60 purchased
    await db.query("select settle_number_credit_quantity($1,'s',90)", [owner]); // real cost 270c -> refund 90c
    expect(await snap(owner)).toMatchObject({ included_remaining_cents: 30, purchased_cents: 500 });
  });

  it("included credit resets on the first of the UTC month and never rolls over; purchased credit does not expire", async () => {
    const owner = await user();
    await activate(owner);
    await addPurchased(owner, 700);
    await reserve(owner, "m1", 50); // spend 150 of the included
    await db.query(
      "update number_credit_accounts set included_period_start = (included_period_start - interval '1 month')::date where owner_user_id=$1",
      [owner],
    );
    // A new month: back to a full $3.00, purchased untouched.
    expect(await snap(owner)).toMatchObject({ included_remaining_cents: 300, purchased_cents: 700 });
    await reserve(owner, "m2", 1);
    expect(await snap(owner)).toMatchObject({ included_remaining_cents: 297, purchased_cents: 700 });
    const row = (await db.query("select included_period_start::text as p, to_char(date_trunc('month', now() at time zone 'utc'), 'YYYY-MM-DD') as cur from number_credit_accounts where owner_user_id=$1", [owner])).rows[0];
    expect(row.p).toBe(row.cur);
  });

  it("no included credit and no spending without an entitled subscription, but purchased credit is kept", async () => {
    const owner = await user();
    expect(await reserve(owner, "n1", 1)).toMatchObject({ allowed: false, reason: "subscription_inactive" });
    await activate(owner);
    await addPurchased(owner, 400);
    await db.query("select apply_number_subscription_event($1,'vendor',$2,(select stripe_subscription_id from number_subscriptions where owner_user_id=$1),'canceled',null,false,now() + interval '1 minute')", [owner, `cus_${owner}`]);
    expect(await snap(owner)).toMatchObject({ included_remaining_cents: 0, purchased_cents: 400 });
    expect(await reserve(owner, "n2", 1)).toMatchObject({ allowed: false, reason: "subscription_inactive" });
  });

  it("past_due keeps purchased credit spendable but grants no included credit", async () => {
    const owner = await user();
    const sub = `sub_${randomUUID()}`;
    await activate(owner, "vendor", sub, new Date(Date.now() - 5000));
    await addPurchased(owner, 400);
    await db.query("select apply_number_subscription_event($1,'vendor',$2,$3,'past_due',null,false,now())", [owner, `cus_${owner}`, sub]);
    expect(await snap(owner)).toMatchObject({ included_remaining_cents: 0, purchased_cents: 400 });
    expect((await reserve(owner, "p1", 10)).allowed).toBe(true);
    expect((await snap(owner)).purchased_cents).toBe(370);
  });

  it("an owner can neither spend nor release another owner's credit", async () => {
    const a = await user();
    const b = await user();
    await activate(a);
    await reserve(a, "iso", 10);
    expect(await reserve(b, "iso2", 1)).toMatchObject({ allowed: false });
    expect((await db.query("select finish_number_credit($1,'iso',true) as r", [b])).rows[0].r).toBe(false);
    await expect(reserve(b, "iso", 10)).rejects.toThrow(/identity mismatch/);
    expect((await snap(a)).included_remaining_cents).toBe(270);
  });

  it("concurrent reservations cannot overspend", async () => {
    const owner = await user();
    await activate(owner);
    const results = await Promise.all(Array.from({ length: 150 }, (_, i) => reserve(owner, `c${i}`, 1)));
    expect(results.filter((r) => r.allowed).length).toBe(100); // 300c / 3c
    expect(await snap(owner)).toMatchObject({ included_remaining_cents: 0, purchased_cents: 0 });
  });

  it("an unavoidable inbound cost debits what exists and the platform absorbs the rest", async () => {
    const owner = await user();
    await activate(owner);
    await reserve(owner, "drain", 99); // 297c of the 300c
    const r = await reserve(owner, "inb", 2, "sms_inbound_segment", 2, true); // 4c, only 3c left
    expect(r.allowed).toBe(true);
    const ev = (await db.query("select total_cents, included_debit_cents, platform_absorbed_cents from number_credit_usage_events where idempotency_key='inb'")).rows[0];
    expect(ev).toMatchObject({ total_cents: 4, included_debit_cents: 3, platform_absorbed_cents: 1 });
    expect(await snap(owner)).toMatchObject({ included_remaining_cents: 0, purchased_cents: 0 });
  });

  it("a purchase credits once, a replayed event adds nothing, a mismatched amount is refused, and a refund reverses once", async () => {
    const owner = await user();
    await activate(owner);
    const purchase = randomUUID();
    await db.query("insert into number_credit_purchases(id, owner_user_id, credit_cents) values($1,$2,2000)", [purchase, owner]);
    await expect(db.query("select fulfill_number_credit_purchase($1,$2,'cs_x','pi_x',3000,'evt_x')", [purchase, owner])).rejects.toThrow(/mismatch/);
    const fulfill = async () =>
      (await db.query("select fulfill_number_credit_purchase($1,$2,'cs_1','pi_1',2000,'evt_1') as r", [purchase, owner])).rows[0].r;
    expect(await fulfill()).toBe(true);
    expect(await fulfill()).toBe(false);
    expect((await snap(owner)).purchased_cents).toBe(2000);
    // Another owner cannot fulfil it.
    const other = await user();
    await expect(db.query("select fulfill_number_credit_purchase($1,$2,'cs_1','pi_1',2000,'evt_9')", [purchase, other])).rejects.toThrow();
    const reverse = async (event: string, cents: number) =>
      (await db.query("select reverse_number_credit_purchase('pi_1',$1,$2,'refund') as r", [cents, event])).rows[0].r;
    expect(await reverse("evt_2", 500)).toBe(true);
    expect(await reverse("evt_2", 500)).toBe(false);
    expect((await snap(owner)).purchased_cents).toBe(1500);
    expect(await reverse("evt_3", 2000)).toBe(true);
    expect((await snap(owner)).purchased_cents).toBe(0);
  });
});
