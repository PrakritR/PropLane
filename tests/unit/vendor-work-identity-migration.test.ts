import { afterAll, beforeAll, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

let db: PGlite;
const vendor = "00000000-0000-0000-0000-000000000111";

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key);");
  await db.exec(readFileSync("supabase/migrations/20260920150000_vendor_sponsored_work_identity.sql", "utf8"));
  await db.query("insert into auth.users(id) values($1)", [vendor]);
  await db.exec("update vendor_work_identity_runtime set enabled=true,max_active_identities=2,outbound_message_cap=3 where singleton=true");
}, 30_000);
afterAll(async () => { await db.close(); });

it("claims one operation once and reserves an outbound payload exactly once", async () => {
  const identity = (await db.query<{ id: string }>("select ensure_vendor_work_identity($1,$2) id", [vendor, "vendor@test.proplane"])).rows[0]!.id;
  await db.query("update vendor_work_identities set email_state='ready',email_provider_id='domain',email_domain_verified=true,email_send_ready=true where id=$1", [identity]);
  const first = (await db.query<{ operation_id: string; claimed: boolean }>("select * from claim_vendor_work_identity_operation($1,$2,'send_email','logical-send')", [vendor, identity])).rows[0]!;
  const replay = (await db.query<{ operation_id: string; claimed: boolean }>("select * from claim_vendor_work_identity_operation($1,$2,'send_email','logical-send')", [vendor, identity])).rows[0]!;
  expect(first.claimed).toBe(true);
  expect(replay).toEqual({ operation_id: first.operation_id, claimed: false, state: "claimed" });
  const outbox = (await db.query<{ claimed: boolean }>("select * from claim_vendor_work_identity_outbound($1,$2,$3,'logical-send','email','manager@test.proplane','thread:t|recipient:m','Subject','Body')", [vendor, identity, first.operation_id])).rows[0]!;
  expect(outbox.claimed).toBe(true);
  const outboxReplay = (await db.query<{ claimed: boolean }>("select * from claim_vendor_work_identity_outbound($1,$2,$3,'logical-send','email','manager@test.proplane','other','Changed','Body')", [vendor, identity, first.operation_id])).rows[0]!;
  expect(outboxReplay.claimed).toBe(false);
  expect((await db.query("select count(*)::int count from vendor_work_identity_usage_events")).rows).toEqual([{ count: 1 }]);
});
