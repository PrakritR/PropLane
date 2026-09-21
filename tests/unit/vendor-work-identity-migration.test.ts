import { afterAll, beforeAll, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

let db: PGlite;
const vendor = "00000000-0000-0000-0000-000000000111";
const vendorTwo = "00000000-0000-0000-0000-000000000222";
const vendorThree = "00000000-0000-0000-0000-000000000333";
const vendorFour = "00000000-0000-0000-0000-000000000444";
const vendorFive = "00000000-0000-0000-0000-000000000555";

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key);");
  await db.exec(readFileSync("supabase/migrations/20260920150000_vendor_sponsored_work_identity.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20260920161000_vendor_work_identity_reply_bindings.sql", "utf8"));
  await db.query("insert into auth.users(id) values($1),($2),($3),($4),($5)", [vendor, vendorTwo, vendorThree, vendorFour, vendorFive]);
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

it("keeps reply authorization binding immutable and service-role-only", async () => {
  const identity = (await db.query<{ id: string }>("select ensure_vendor_work_identity($1,$2) id", [vendor, "vendor@test.proplane"])).rows[0]!.id;
  await db.query("insert into vendor_work_identity_reply_bindings(identity_id,vendor_user_id,thread_id,channel,recipient) values($1,$2,'thread-1','email','manager@test.proplane')", [identity, vendor]);
  await expect(db.query("insert into vendor_work_identity_reply_bindings(identity_id,vendor_user_id,thread_id,channel,recipient) values($1,$2,'thread-1','email','attacker@test.proplane')", [identity, vendor])).rejects.toThrow();
  expect((await db.query("select recipient from vendor_work_identity_reply_bindings where vendor_user_id=$1 and thread_id='thread-1'", [vendor])).rows).toEqual([{ recipient: "manager@test.proplane" }]);
});

it("joins fresh setup request ids to one in-flight channel operation", async () => {
  const identity = (await db.query<{ id: string }>("select ensure_vendor_work_identity($1,$2) id", [vendor, "vendor@test.proplane"])).rows[0]!.id;
  const first = (await db.query<{ operation_id: string; claimed: boolean; state: string }>("select * from claim_vendor_work_identity_operation($1,$2,'setup_email','00000000-0000-4000-8000-000000000011')", [vendor, identity])).rows[0]!;
  const fresh = (await db.query<{ operation_id: string; claimed: boolean; state: string }>("select * from claim_vendor_work_identity_operation($1,$2,'setup_email','00000000-0000-4000-8000-000000000012')", [vendor, identity])).rows[0]!;
  expect(first).toMatchObject({ claimed: true, state: "claimed" });
  expect(fresh).toEqual({ operation_id: first.operation_id, claimed: false, state: "claimed" });
});

it("claims a queued provider release only once and returns its surviving identity", async () => {
  const identity = (await db.query<{ id: string }>("select ensure_vendor_work_identity($1,$2) id", [vendorTwo, "release@test.proplane"])).rows[0]!.id;
  await db.query(
    "insert into vendor_work_identity_release_queue(vendor_user_id,identity_id,phone_number_sid,idempotency_key) values($1,$2,'PN-release','release-test')",
    [vendorTwo, identity],
  );
  const first = (await db.query<{ id: string; identity_id: string; phone_number_sid: string }>("select * from claim_vendor_work_identity_releases(1)")).rows;
  const replay = (await db.query("select * from claim_vendor_work_identity_releases(1)")).rows;
  expect(first).toEqual([{ id: expect.any(String), identity_id: identity, phone_number_sid: "PN-release" }]);
  expect(replay).toEqual([]);
});

it("counts a surviving disabled identity and an orphaned queue resource once each", async () => {
  await db.exec("update vendor_work_identity_runtime set max_active_identities=4 where singleton=true");
  const disabled = (await db.query<{ id: string }>("select ensure_vendor_work_identity($1,$2) id", [vendorThree, "disabled@test.proplane"])).rows[0]!.id;
  await db.query(
    "insert into vendor_work_identity_release_queue(vendor_user_id,identity_id,idempotency_key) values($1,$2,'surviving-disabled')",
    [vendorThree, disabled],
  );
  await db.query("update vendor_work_identities set lifecycle_state='disabled', disabled_at=now() where id=$1", [disabled]);
  // The existing identities plus this queued surviving identity consume three
  // resources, so one more can still be allocated at cap four.
  expect((await db.query<{ id: string | null }>("select ensure_vendor_work_identity($1,$2) id", [vendorFour, "third@test.proplane"])).rows[0]!.id).toEqual(expect.any(String));
  await db.exec("update vendor_work_identity_runtime set max_active_identities=5 where singleton=true");
  await db.query(
    "insert into vendor_work_identity_release_queue(vendor_user_id,identity_id,idempotency_key) values($1,$2,'orphaned-resource')",
    [vendorTwo, null],
  );
  expect((await db.query<{ id: string | null }>("select ensure_vendor_work_identity($1,$2) id", [vendorFive, "blocked@test.proplane"])).rows[0]!.id).toBeNull();
});
