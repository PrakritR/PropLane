import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create table profiles(id uuid primary key,role text);
    create table profile_roles(user_id uuid,role text);`);
  await db.exec(readFileSync("supabase/migrations/20260907224000_account_recovery_shared_retention.sql", "utf8"));
  await db.exec(`create table manager_application_records(id text primary key, manager_user_id uuid, resident_email text);
    create table child_records(id text primary key, application_id text references manager_application_records(id) on delete cascade, manager_user_id uuid);
    create table screening_orders(id text primary key, application_id text);
    create table cosigner_submission_records(id text primary key, signer_app_id text);`);
  await db.exec(readFileSync("supabase/migrations/20260907224500_account_recovery_snapshot.sql", "utf8"));
  await db.exec(`create table audit_log(id uuid primary key,actor_user_id uuid not null);`);
  for (const table of ["ledger_entries", "security_deposit_ledger", "manager_payment_plans", "portal_household_charge_records", "portal_lease_pipeline_records"]) {
    await db.exec(`create table ${table}(id uuid primary key,manager_user_id uuid,resident_user_id uuid,resident_email text,amount_cents integer,row_data jsonb);`);
  }
  await db.exec(readFileSync("supabase/migrations/20260907214100_preserve_resident_financial_history.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20260907225000_account_recovery_identity_patches.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20260907231000_account_recovery_financial_access_keys.sql", "utf8"));
}, 30_000);
afterAll(async () => { await db?.close(); });

async function request(portal: string) {
  const user = crypto.randomUUID();
  await db.query("insert into auth.users values($1,$2)", [user, `${user}@example.test`]);
  await db.query("insert into profiles values($1,$2)", [user, portal]);
  const { rows: [row] } = await db.query<{ id: string }>("select account_recovery_open($1,$2,'{}',$3) id", [user, portal, { full_name: "Saved name", role: "admin", stripe_account_id: "never-restore" }]);
  return { id: row.id, user, hash: "a".repeat(64) };
}
async function hold(a: { id: string }, key: string, kind = "delete") {
  const { rows: [row] } = await db.query<{ id: string }>("select account_recovery_add_hold($1,'example_records',$2,$3,$4,true,2) id",
    [a.id, { id: key }, { id: key, amount_cents: 125000 }, kind]);
  return row.id;
}
async function retained(a: { id: string }) {
  await db.query("update account_recovery_requests set state='retained' where id=$1", [a.id]);
  await db.query("update account_recovery_records set archived=true where id in(select record_id from account_recovery_holds where request_id=$1 and kind='delete')", [a.id]);
}
async function choose(a: { id: string; user: string; hash: string }, choice: string) {
  await db.query("select account_recovery_issue_challenge($1,$2,$3)", [a.id, a.user, a.hash]);
  const { rows: [row] } = await db.query<{ claim: string }>("select account_recovery_choose($1,$2,$3,$4) claim", [a.id, a.user, a.hash, choice]);
  return row.claim;
}
async function publishable(id: string) {
  return (await db.query<{ ready: boolean }>("select account_recovery_publishable($1) ready", [id])).rows[0].ready;
}

describe("shared recovery ownership", () => {
  it("keeps one copy and waits for both owners to choose recovery", async () => {
    const a = await request("manager"), b = await request("resident");
    const key = crypto.randomUUID();
    const record = await hold(a, key);
    expect(await hold(b, key)).toBe(record);
    await retained(a); await retained(b);
    await choose(a, "recover");
    expect(await publishable(record)).toBe(false);
    await choose(b, "recover");
    expect(await publishable(record)).toBe(true);
  });

  it.each(["manager", "resident"])("%s starting fresh vetoes only the jointly owned record generation", async first => {
    const a = await request(first), b = await request(first === "manager" ? "resident" : "manager");
    const key = crypto.randomUUID();
    const record = await hold(a, key); await hold(b, key);
    const unrelated = await hold(b, crypto.randomUUID());
    await retained(a); await retained(b);
    await choose(b, "recover");
    const claim = await choose(a, "fresh");
    await db.query("select account_recovery_erase_records($1,$2)", [a.id, claim]);
    expect(await publishable(record)).toBe(false);
    expect(await publishable(unrelated)).toBe(true);
    expect((await db.query("select erased,payload from account_recovery_records where id=$1", [record])).rows[0]).toEqual({ erased: true, payload: null });
    const later = await request(first);
    await expect(hold(later, key)).rejects.toThrow(/permanently erased/);
  });

  it("reference deletion never erases the surviving manager's financial payload", async () => {
    const resident = await request("resident"), manager = await request("manager");
    const key = crypto.randomUUID();
    const record = await hold(resident, key, "reference");
    await hold(manager, key);
    await retained(manager);
    await db.query("select account_recovery_detach_reference($1,$2,'{}','{}',false)", [resident.id, record]);
    await retained(resident);
    const claim = await choose(resident, "fresh");
    await db.query("select account_recovery_erase_records($1,$2)", [resident.id, claim]);
    await choose(manager, "recover");
    expect(await publishable(record)).toBe(true);
    expect((await db.query("select payload from account_recovery_records where id=$1", [record])).rows[0].payload).toMatchObject({ amount_cents: 125000 });
  });

  it("never archives profile privileges or billing configuration", async () => {
    const a = await request("resident");
    expect((await db.query("select profile_data from account_recovery_requests where id=$1", [a.id])).rows[0].profile_data).toEqual({ full_name: "Saved name" });
  });

  it("retries the same confirmed choice but refuses a changed choice or another user", async () => {
    const a = await request("resident"); await retained(a);
    const claim = await choose(a, "recover");
    expect((await db.query("select account_recovery_choose($1,$2,$3,'recover') claim", [a.id, a.user, a.hash])).rows[0].claim).toBe(claim);
    await expect(db.query("select account_recovery_choose($1,$2,$3,'fresh')", [a.id, a.user, a.hash])).rejects.toThrow(/expired or already used/);
    await expect(db.query("select account_recovery_choose($1,$2,$3,'recover')", [a.id, crypto.randomUUID(), a.hash])).rejects.toThrow(/Invalid recovery choice/);
  });

  it("does not extend the original deadline on repeated deletion requests", async () => {
    const a = await request("resident");
    const before = (await db.query("select expires_at from account_recovery_requests where id=$1", [a.id])).rows[0];
    expect((await db.query("select account_recovery_open($1,'resident','{}','{}') id", [a.user])).rows[0].id).toBe(a.id);
    expect((await db.query("select expires_at from account_recovery_requests where id=$1", [a.id])).rows[0]).toEqual(before);
  });

  it("refuses recovery at expiry and claims expiry without changing a prior fresh decision", async () => {
    const expired = await request("resident"), fresh = await request("resident");
    await retained(expired); await retained(fresh);
    const freshClaim = await choose(fresh, "fresh");
    await db.query("update account_recovery_requests set created_at=now()-interval '31 days',expires_at=now()-interval '1 day' where id=any($1::uuid[])", [[expired.id, fresh.id]]);
    await expect(choose(expired, "recover")).rejects.toThrow(/expired or already used/);
    await db.query("select account_recovery_claim_expired(20)");
    expect((await db.query("select decision from account_recovery_requests where id=$1", [expired.id])).rows[0].decision).toBe("expire");
    expect((await db.query("select decision,claim_id from account_recovery_requests where id=$1", [fresh.id])).rows[0]).toEqual({ decision: "fresh", claim_id: freshClaim });
  });

  it("denies browser access to retained data and lifecycle RPCs", async () => {
    const { rows: [row] } = await db.query(`select
      has_table_privilege('authenticated','account_recovery_records','SELECT') data_access,
      has_function_privilege('authenticated','account_recovery_choose(uuid,uuid,text,text)','EXECUTE') choice_access`);
    expect(row).toEqual({ data_access: false, choice_access: false });
  });
});


it("captures declared and legacy children, including edges for children already held by the manifest", async () => {
  const a = await request("manager");
  const id = crypto.randomUUID();
  await db.query("insert into manager_application_records values($1,$2,'resident@example.test')", [id, a.user]);
  await db.query("insert into child_records values($1,$1,$2)", [id, a.user]);
  await db.query("insert into screening_orders values($1,$1)", [id]);
  await db.query("insert into cosigner_submission_records values($1,$1)", [id]);
  await db.query("update account_recovery_requests set plan=$2 where id=$1", [a.id, {
    rules: ["manager_application_records", "child_records"].map(table => ({ table, ids: ["manager_user_id"], recover: true, phase: 2 })),
    recoverableTables: ["manager_application_records", "child_records"],
  }]);
  await db.query("select account_recovery_snapshot($1)", [a.id]);
  const { rows: [row] } = await db.query<{ edges: number; holds: number }>(`select
    (select count(*)::integer from account_recovery_dependencies where parent_id in(select record_id from account_recovery_holds where request_id=$1)) edges,
    (select count(*)::integer from account_recovery_holds where request_id=$1) holds`, [a.id]);
  expect(row).toEqual({ edges: 3, holds: 4 });
});

it("returns the same expiry claim after an interrupted worker", async () => {
  const a = await request("resident"); await retained(a);
  await db.query("update account_recovery_requests set created_at=now()-interval '32 days',expires_at=now()-interval '2 days' where id=$1", [a.id]);
  const first = (await db.query<{ id: string; claim_id: string }>("select * from account_recovery_claim_expired(20)")).rows.find(row => row.id === a.id);
  const retry = (await db.query<{ id: string; claim_id: string }>("select * from account_recovery_claim_expired(20)")).rows.find(row => row.id === a.id);
  expect(first?.claim_id).toBeTruthy();
  expect(retry?.claim_id).toBe(first?.claim_id);
});


it.each(["manager-first", "resident-first"])("detaches real financial identities in live and retained data: %s", async order => {
  const manager = await request("manager"), resident = await request("resident");
  const id = crypto.randomUUID();
  const email = `${resident.user}@example.test`;
  const payload = { id, manager_user_id: manager.user, resident_user_id: resident.user, resident_email: email,
    amount_cents: 125000, row_data: { residentUserId: resident.user, residentEmail: email, status: "paid", payments: [{ amount_cents: 20000, resident_email: email }] } };
  await db.query("insert into ledger_entries select * from jsonb_populate_record(null::ledger_entries,$1)", [payload]);
  const add = async (a: { id: string }, kind: string) => (await db.query<{ id: string }>("select account_recovery_add_hold($1,'ledger_entries',$2,$3,$4,true,1) id", [a.id, { id }, payload, kind])).rows[0].id;
  let record: string;
  if (order === "manager-first") {
    record = await add(manager, "delete"); await retained(manager);
    await db.query("delete from ledger_entries where id=$1", [id]);
    await add(resident, "reference");
  } else {
    record = await add(resident, "reference");
  }
  await db.query("select account_recovery_detach_reference($1,$2,ARRAY['resident_user_id'],ARRAY['resident_email'],true)", [resident.id, record]);
  if (order === "resident-first") {
    const live = (await db.query("select * from ledger_entries where id=$1", [id])).rows[0];
    expect(live).toMatchObject({ resident_user_id: null, amount_cents: 125000 });
    await db.query("select account_recovery_add_hold($1,'ledger_entries',$2,$3,'delete',true,1)", [manager.id, { id }, live]);
    await retained(manager);
  }
  await retained(resident);
  const claim = await choose(resident, "fresh");
  await db.query("select account_recovery_erase_records($1,$2)", [resident.id, claim]);
  await choose(manager, "recover");
  expect(await publishable(record)).toBe(true);
  const stored = (await db.query("select payload from account_recovery_records where id=$1", [record])).rows[0].payload;
  expect(stored).toMatchObject({ manager_user_id: manager.user, resident_user_id: null, amount_cents: 125000 });
  expect(JSON.stringify(stored)).not.toContain(resident.user);
  expect(JSON.stringify(stored)).not.toContain(email);
});
