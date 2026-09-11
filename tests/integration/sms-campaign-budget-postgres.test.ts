import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.SMS_CAMPAIGN_BUDGET_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(target.hostname) || !target.pathname.startsWith("/sms_campaign_test"))
    throw new Error("Campaign tests require a disposable local sms_campaign_test database.");
}
const db = new Pool({ connectionString: url, max: 10 });
afterAll(() => db.end());

(url ? describe.sequential : describe.skip)("idempotent daily SMS campaign reservation", () => {
  beforeAll(async () => {
    // Minimal rows needed by the two REAL migration functions. No provider or wallet mocks.
    await db.query(`
      create table sms_runtime_config(singleton boolean primary key, campaign_daily_segment_limit integer);
      create table sms_segment_usage(usage_date date primary key, segment_count integer not null, updated_at timestamptz default now());
      create table sms_outbox(id uuid primary key, status text not null, segment_count integer not null check(segment_count between 1 and 10), lease_owner text, lease_expires_at timestamptz);
    `);
    const controlPlane = readFileSync("supabase/migrations/20260825120000_sms_control_plane.sql", "utf8");
    const spend = controlPlane.match(/create or replace function public\.spend_sms_segment_budget\(p_segments integer\)[\s\S]*?\n\$\$;/)?.[0];
    if (!spend) throw new Error("Canonical campaign spend migration function is missing");
    await db.query(spend);
    await db.query(readFileSync("supabase/migrations/20260910190000_sms_outbox_campaign_budget.sql", "utf8"));
  });
  beforeEach(async () => {
    await db.query("truncate sms_outbox, sms_segment_usage, sms_runtime_config; insert into sms_runtime_config values(true,3)");
  });
  async function message(segments = 1) {
    const id = randomUUID();
    await db.query("insert into sms_outbox values($1,'submitting',$2,'worker',now()+interval '1 hour',null)", [id, segments]);
    return id;
  }
  async function spend(id: string, worker = "worker") {
    return (await db.query("select spend_sms_outbox_segment_budget($1,$2) as allowed", [id, worker])).rows[0].allowed;
  }
  async function used() {
    return Number((await db.query("select coalesce(sum(segment_count),0) as used from sms_segment_usage")).rows[0].used);
  }
  it("deduplicates concurrent calls and a retry after a lost successful response", async () => {
    const id = await message(2);
    expect(await Promise.all(Array.from({ length: 8 }, () => spend(id)))).toEqual(Array(8).fill(true));
    expect(await spend(id)).toBe(true);
    expect(await used()).toBe(2);
  });
  it("shares the cap across messages and leaves a rejected message unmarked", async () => {
    const first = await message(2), second = await message(2), third = await message(1);
    expect(await spend(first)).toBe(true);
    expect(await spend(second)).toBe(false);
    expect((await db.query("select campaign_budget_spent_on from sms_outbox where id=$1", [second])).rows[0].campaign_budget_spent_on).toBeNull();
    expect(await spend(third)).toBe(true);
    expect(await used()).toBe(3);
  });
  it("counts a previous day's message against today's UTC cap", async () => {
    const id = await message(2);
    await db.query("update sms_outbox set campaign_budget_spent_on=(now() at time zone 'UTC')::date-1 where id=$1", [id]);
    expect(await spend(id)).toBe(true);
    expect(await used()).toBe(2);
    expect((await db.query("select campaign_budget_spent_on=(now() at time zone 'UTC')::date as today from sms_outbox where id=$1", [id])).rows[0].today).toBe(true);
  });
  it("rejects wrong, expired, or no longer submitting claims even after allocation", async () => {
    const id = await message();
    // A prior allocation must never let a stale claimant bypass ownership.
    expect(await spend(id)).toBe(true);
    await expect(spend(id, "stale-worker")).rejects.toThrow("claim is no longer current");
    await db.query("update sms_outbox set lease_expires_at=now()-interval '1 second' where id=$1", [id]);
    await expect(spend(id)).rejects.toThrow("claim is no longer current");
    await db.query("update sms_outbox set lease_expires_at=now()+interval '1 hour',status='deferred' where id=$1", [id]);
    await expect(spend(id)).rejects.toThrow("claim is no longer current");
    expect(await used()).toBe(1);
  });
  it("allows only the service role to execute the reservation", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const result = await db.query("select has_function_privilege($1,'public.spend_sms_outbox_segment_budget(uuid,text)','execute') as allowed", [role]);
      expect(result.rows[0].allowed).toBe(role === "service_role");
    }
  });
});
