import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.PAYMENT_AUDIT_TEST_DATABASE_URL;
if (url && !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  throw new Error("Payout-cache proof requires a disposable local PostgreSQL database.");
}
const suite = url ? describe : describe.skip;
const db = new Pool({ connectionString: url, max: 4 });
const original = readFileSync("supabase/migrations/20260920212000_payout_destinations_cache.sql", "utf8");
const migration = readFileSync("supabase/migrations/20261004210000_payout_destination_cache_refresh.sql", "utf8");

async function token(owner: string): Promise<number> {
  return Number((await db.query("select public.begin_payout_destination_cache_refresh($1) as version", [owner])).rows[0].version);
}
async function finish(owner: string, accountId: string, version: number, destinations: unknown[]) {
  return (await db.query("select public.finish_payout_destination_cache_refresh($1,$2,$3,$4::jsonb) as applied",
    [owner, accountId, version, JSON.stringify(destinations)])).rows[0].applied as boolean;
}

suite("payout destination display-cache refresh on local PostgreSQL", () => {
  beforeAll(async () => {
    await db.query("create table if not exists public.profiles(id uuid primary key references auth.users(id) on delete cascade, stripe_connect_account_id text)");
    await db.query(original);
    await db.query(migration);
    await db.query(migration);
  });
  afterAll(async () => { await db.end(); });

  it("permits only service-role execution and no client writes to refresh state", async () => {
    for (const signature of ["begin_payout_destination_cache_refresh(uuid)",
      "finish_payout_destination_cache_refresh(uuid,text,bigint,jsonb)"]) {
      for (const role of ["anon", "authenticated"]) {
        expect((await db.query("select has_function_privilege($1,$2,'execute') as allowed",
          [role, `public.${signature}`])).rows[0].allowed).toBe(false);
      }
      expect((await db.query("select has_function_privilege('service_role',$1,'execute') as allowed",
        [`public.${signature}`])).rows[0].allowed).toBe(true);
    }
    expect((await db.query("select has_table_privilege('authenticated','public.payout_destination_cache_refreshes','INSERT') as allowed")).rows[0].allowed).toBe(false);
  });

  it("serializes duplicate refreshes and leaves the newer owner snapshot after older empty response", async () => {
    const owner = randomUUID(), other = randomUUID();
    await db.query("insert into auth.users(id) values($1),($2)", [owner, other]);
    await db.query("insert into public.profiles(id,stripe_connect_account_id) values($1,'acct_owner'),($2,'acct_other')", [owner, other]);
    const otherToken = await token(other);
    await finish(other, "acct_other", otherToken, [{ id: "ba_other", kind: "bank", label: "Other", last4: "9999", status: "verified", is_default: true }]);

    const older = await token(owner);
    const newer = await token(owner);
    const current = [{ id: "ba_current", kind: "bank", label: "New bank", last4: "1234", status: "verified", is_default: true }];
    const [oldResult, newResult] = await Promise.all([finish(owner, "acct_owner", older, []), finish(owner, "acct_owner", newer, current)]);
    expect(oldResult || newResult).toBe(true);
    expect(await finish(owner, "acct_owner", older, [])).toBe(false);
    const rows = (await db.query("select stripe_external_account_id,label from public.payout_destinations_cache where owner_user_id=$1", [owner])).rows;
    expect(rows).toEqual([{ stripe_external_account_id: "ba_current", label: "New bank" }]);
    expect((await db.query("select stripe_external_account_id from public.payout_destinations_cache where owner_user_id=$1", [other])).rows)
      .toEqual([{ stripe_external_account_id: "ba_other" }]);

    const latest = await token(owner);
    expect(await finish(owner, "acct_owner", latest, current)).toBe(true);
    expect((await db.query("select count(*)::int as count from public.payout_destinations_cache where owner_user_id=$1", [owner])).rows[0].count).toBe(1);
    await db.query("update public.profiles set stripe_connect_account_id='acct_relinked' where id=$1", [owner]);
    expect(await finish(owner, "acct_owner", await token(owner), [])).toBe(false);
    expect((await db.query("select count(*)::int as count from public.payout_destinations_cache where owner_user_id=$1", [owner])).rows[0].count).toBe(1);
  });

  it("serializes two simultaneous replacements behind the same owner row lock", async () => {
    const owner = randomUUID();
    await db.query("insert into auth.users(id) values($1)", [owner]);
    await db.query("insert into public.profiles(id,stripe_connect_account_id) values($1,'acct_race')", [owner]);
    await finish(owner, "acct_race", await token(owner), []);
    const older = await token(owner), newer = await token(owner);
    const blocker = await db.connect(), first = await db.connect(), second = await db.connect();
    let blocked = false;
    try {
      await blocker.query("begin");
      await blocker.query("select applied_version from public.payout_destination_cache_refreshes where owner_user_id=$1 for update", [owner]);
      const firstPid = (await first.query("select pg_backend_pid() as pid")).rows[0].pid;
      const secondPid = (await second.query("select pg_backend_pid() as pid")).rows[0].pid;
      const oldWrite = first.query("select public.finish_payout_destination_cache_refresh($1,$2,$3,$4::jsonb) as applied",
        [owner, "acct_race", older, JSON.stringify([])]);
      const newWrite = second.query("select public.finish_payout_destination_cache_refresh($1,$2,$3,$4::jsonb) as applied",
        [owner, "acct_race", newer, JSON.stringify([{ id: "ba_winner", kind: "bank", label: "Latest", last4: "1234", status: "verified", is_default: true }])]);
      for (let n = 0; n < 100; n++) {
        const waits = await db.query("select count(*)::int as count from pg_stat_activity where pid=any($1::int[]) and wait_event_type='Lock'", [[firstPid, secondPid]]);
        if (waits.rows[0].count === 2) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await blocker.query("commit");
      await Promise.all([oldWrite, newWrite]);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release(); first.release(); second.release();
    }
    expect(blocked).toBe(true);
    expect((await db.query("select stripe_external_account_id from public.payout_destinations_cache where owner_user_id=$1", [owner])).rows)
      .toEqual([{ stripe_external_account_id: "ba_winner" }]);
  });
});
