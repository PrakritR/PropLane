import { beforeAll, afterAll, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create table profiles(id uuid primary key,role text,email text,full_name text,phone text,preferred_language text);
    create table profile_roles(user_id uuid,role text,primary key(user_id,role));
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean);
    create table storage.objects(bucket_id text,name text);
    create table document_rows(id text primary key,manager_user_id uuid,superseded_id text references document_rows(id) on delete set null);
    create table audit_log(id uuid primary key,actor_user_id uuid not null);
    create table manager_application_records(id text primary key,manager_user_id uuid,resident_email text);
    create table child_records(id text primary key,application_id text references manager_application_records(id) on delete cascade);
    create table screening_orders(id text primary key,application_id text);
    create table cosigner_submission_records(id text primary key,signer_app_id text);`);
  for (const table of ["ledger_entries", "security_deposit_ledger", "manager_payment_plans", "portal_household_charge_records", "portal_lease_pipeline_records"]) {
    await db.exec(`create table ${table}(id uuid primary key,manager_user_id uuid,resident_user_id uuid,resident_email text,amount_cents integer,row_data jsonb);`);
  }
  for (const file of [
    "20260907214100_preserve_resident_financial_history.sql", "20260907224000_account_recovery_shared_retention.sql",
    "20260907224500_account_recovery_snapshot.sql", "20260907225000_account_recovery_identity_patches.sql",
    "20260907225500_account_recovery_capture.sql", "20260907230000_account_recovery_object_generations.sql",
    "20260907231000_account_recovery_financial_access_keys.sql", "20260907232000_account_recovery_restore.sql",
    "20260907233000_account_recovery_finish_archival.sql",
  ]) await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
}, 30_000);
afterAll(async () => { await db?.close(); });

async function user(role: string) {
  const id = crypto.randomUUID(), email = `${id}@example.test`;
  await db.query("insert into auth.users(id,email) values($1,$2)", [id, email]);
  await db.query("insert into profiles(id,role) values($1,$2)", [id, role]);
  return { id, email };
}

it("atomically captures private rows, freezes new children, and lets the manifest delete the captured generation", async () => {
  const manager = await user("manager"), resident = await user("resident");
  const id = crypto.randomUUID();
  await db.query("insert into manager_application_records values($1,$2,$3)", [id, manager.id, resident.email]);
  await db.query("insert into child_records values($1,$1)", [id]);
  await db.query("insert into screening_orders values($1,$1)", [id]);
  const plan = { rules: [{ table: "manager_application_records", emails: ["resident_email"], recover: true, phase: 2 }], recoverableTables: ["manager_application_records", "child_records"] };
  const { rows: [a] } = await db.query<{ id: string }>("select account_recovery_begin($1,'resident',$2,'{}') id", [resident.id, plan]);
  await expect(db.query("insert into child_records values($1,$2)", [crypto.randomUUID(), id])).rejects.toThrow(/New child/);
  await expect(db.query("insert into screening_orders values($1,$2)", [crypto.randomUUID(), id])).rejects.toThrow(/New child/);
  await expect(db.query("update manager_application_records set resident_email='different@example.test' where id=$1", [id])).rejects.toThrow(/recovery decision/);
  await expect(db.query("update child_records set id=$2 where id=$1", [id, crypto.randomUUID()])).rejects.toThrow(/Retained child/);
  await db.query("delete from screening_orders where application_id=$1", [id]);
  await db.query("delete from manager_application_records where id=$1", [id]);
  const { rows } = await db.query("select r.table_name,r.archived from account_recovery_records r join account_recovery_holds h on h.record_id=r.id where h.request_id=$1 order by r.table_name", [a.id]);
  expect(rows).toEqual([
    { table_name: "child_records", archived: true }, { table_name: "manager_application_records", archived: true }, { table_name: "screening_orders", archived: true },
  ]);
  await expect(db.query("insert into manager_application_records values($1,$2,$3)", [id, manager.id, resident.email])).rejects.toThrow(/generation cannot be overwritten/);
});

it("lets the manager edit money while freezing the deleted resident identity", async () => {
  const manager = await user("manager"), resident = await user("resident");
  const id = crypto.randomUUID();
  await db.query("insert into ledger_entries values($1,$2,$3,$4,125000,$5)", [id, manager.id, resident.id, resident.email, { residentUserId: resident.id, residentEmail: resident.email, status: "paid" }]);
  const plan = { rules: [{ table: "ledger_entries", ids: ["resident_user_id"], emails: ["resident_email"], retainFinancial: true, recover: true, phase: 1 }], recoverableTables: ["ledger_entries"] };
  await db.query("select account_recovery_begin($1,'resident',$2,'{}')", [resident.id, plan]);
  await db.query("update ledger_entries set amount_cents=140000 where id=$1", [id]);
  expect((await db.query("select resident_user_id,amount_cents from ledger_entries where id=$1", [id])).rows[0]).toEqual({ resident_user_id: null, amount_cents: 140000 });
  await expect(db.query("update ledger_entries set resident_email=$2 where id=$1", [id, resident.email])).rejects.toThrow(/Deleted resident identity/);
});


it("restores a resident's profile and dependency rows atomically, using only the selected role", async () => {
  const manager = await user("manager"), resident = await user("resident");
  const id = crypto.randomUUID();
  await db.query("insert into manager_application_records values($1,$2,$3)", [id, manager.id, resident.email]);
  await db.query("insert into child_records values($1,$1)", [id]);
  const plan = { rules: [{ table: "manager_application_records", emails: ["resident_email"], recover: true, phase: 2 }], recoverableTables: ["manager_application_records", "child_records"] };
  const { rows: [a] } = await db.query<{ id: string }>("select account_recovery_begin($1,'resident',$2,$3) id", [resident.id, plan, { full_name: "Original name", role: "admin" }]);
  await db.query("delete from manager_application_records where id=$1", [id]);
  await db.query("select account_recovery_finish_archival($1)", [a.id]);
  expect((await db.query("select * from profiles where id=$1", [resident.id])).rows).toEqual([]);
  const hash = "b".repeat(64);
  await db.query("select account_recovery_issue_challenge($1,$2,$3)", [a.id, resident.id, hash]);
  const { rows: [result] } = await db.query<{ result: { restored: number } }>("select account_recovery_recover($1,$2,$3) result", [a.id, resident.id, hash]);
  expect(result.result.restored).toBe(2);
  expect((await db.query("select role,full_name from profiles where id=$1", [resident.id])).rows[0]).toEqual({ role: "resident", full_name: "Original name" });
  expect((await db.query("select role from profile_roles where user_id=$1", [resident.id])).rows).toEqual([{ role: "resident" }]);
  expect((await db.query("select * from child_records where id=$1", [id])).rows).toHaveLength(1);
});

it("recovers only the resident identity without rolling back the manager's financial edits", async () => {
  const manager = await user("manager"), resident = await user("resident");
  const id = crypto.randomUUID();
  await db.query("insert into ledger_entries values($1,$2,$3,$4,125000,$5)", [id, manager.id, resident.id, resident.email, { residentUserId: resident.id, residentEmail: resident.email, status: "paid" }]);
  const plan = { rules: [{ table: "ledger_entries", ids: ["resident_user_id"], emails: ["resident_email"], retainFinancial: true, recover: true, phase: 1 }], recoverableTables: ["ledger_entries"] };
  const { rows: [a] } = await db.query<{ id: string }>("select account_recovery_begin($1,'resident',$2,'{}') id", [resident.id, plan]);
  await db.query("select account_recovery_finish_archival($1)", [a.id]);
  await db.query("update ledger_entries set amount_cents=140000 where id=$1", [id]);
  const hash = "c".repeat(64);
  await db.query("select account_recovery_issue_challenge($1,$2,$3)", [a.id, resident.id, hash]);
  await db.query("select account_recovery_recover($1,$2,$3)", [a.id, resident.id, hash]);
  expect((await db.query("select resident_user_id,resident_email,amount_cents,row_data from ledger_entries where id=$1", [id])).rows[0]).toEqual({
    resident_user_id: resident.id, resident_email: resident.email, amount_cents: 140000,
    row_data: { residentUserId: resident.id, residentEmail: resident.email, status: "paid" },
  });
});

it("detaches the applicable resident identity when complete manager deletion lists manager rules first", async () => {
  const owner = await user("manager"), deleting = await user("manager");
  const id = crypto.randomUUID();
  await db.query("insert into ledger_entries values($1,$2,$3,$4,125000,'{}')", [id, owner.id, deleting.id, deleting.email]);
  const plan = { complete: true, rules: [
    { table: "ledger_entries", ids: ["manager_user_id"], recover: true, phase: 1 },
    { table: "ledger_entries", ids: ["resident_user_id"], emails: ["resident_email"], retainFinancial: true, recover: true, phase: 1 },
  ], recoverableTables: ["ledger_entries"] };
  const { rows: [a] } = await db.query<{ id: string }>("select account_recovery_begin($1,'manager',$2,'{}') id", [deleting.id, plan]);
  expect((await db.query("select manager_user_id,resident_user_id from ledger_entries where id=$1", [id])).rows[0]).toEqual({ manager_user_id: owner.id, resident_user_id: null });
  await expect(db.query("update ledger_entries set resident_email=$2 where id=$1", [id, deleting.email])).rejects.toThrow(/Deleted resident identity/);
  await db.query("select account_recovery_finish_archival($1)", [a.id]);
  const hash = "d".repeat(64);
  await db.query("select account_recovery_issue_challenge($1,$2,$3)", [a.id, deleting.id, hash]);
  const { rows: [claim] } = await db.query<{ id: string }>("select account_recovery_choose($1,$2,$3,'fresh') id", [a.id, deleting.id, hash]);
  await db.query("select account_recovery_prepare_object_purge($1,$2)", [a.id, claim.id]);
  await db.query("select account_recovery_prepare_object_purge($1,$2)", [a.id, claim.id]);
  expect((await db.query("select amount_cents from ledger_entries where id=$1", [id])).rows[0]).toEqual({ amount_cents: 125000 });
});

it("permanently retires an original physical file key at archival while allowing logical recovery", async () => {
  const resident = await user("resident"), path = `${resident.id}/proof.pdf`;
  const { rows: [a] } = await db.query<{ id: string }>("select account_recovery_begin($1,'resident',$2,'{}') id", [resident.id, { rules: [], recoverableTables: [] }]);
  const { rows: [object] } = await db.query<{ id: string; generation: string }>("select (account_recovery_register_object($1,'portal-inbox-attachments',$2,$2,'')).*", [a.id, path]);
  await db.query("select account_recovery_object_progress($1,$2,true,true)", [object.id, object.generation]);
  await db.query("select account_recovery_finish_archival($1)", [a.id]);
  const hash = "e".repeat(64);
  await db.query("select account_recovery_issue_challenge($1,$2,$3)", [a.id, resident.id, hash]);
  await db.query("select account_recovery_recover($1,$2,$3)", [a.id, resident.id, hash]);
  expect((await db.query("select state from account_recovery_objects where id=$1", [object.id])).rows[0]).toEqual({ state: "active" });
  await expect(db.query("insert into storage.objects values('portal-inbox-attachments',$1)", [path])).rejects.toThrow(/Retired physical/);
  const { rows: [next] } = await db.query<{ id: string }>("select account_recovery_begin($1,'resident',$2,'{}') id", [resident.id, { rules: [], recoverableTables: [] }]);
  // A logical asset is allowed to move to a new private generation on re-deletion.
  await db.query("select account_recovery_register_object($1,'portal-inbox-attachments',$2,$2,'')", [next.id, path]);
  expect((await db.query("select state,source_bucket from account_recovery_objects where id=$1", [object.id])).rows[0]).toEqual({ state: "copying", source_bucket: "account-recovery" });
});

it("a Fresh choice vetoes a shared unreferenced file even while another holder has not chosen", async () => {
  const first = await user("resident"), second = await user("resident"), path = `${crypto.randomUUID()}/shared.pdf`;
  const requests: string[] = [];
  let objectId = "";
  for (const actor of [first, second]) {
    const { rows: [a] } = await db.query<{ id: string }>("select account_recovery_begin($1,'resident',$2,'{}') id", [actor.id, { rules: [], recoverableTables: [] }]);
    requests.push(a.id);
    const { rows: [object] } = await db.query<{ id: string; generation: string }>("select (account_recovery_register_object($1,'portal-inbox-attachments',$2,$2,'')).*", [a.id, path]);
    objectId = object.id;
    await db.query("select account_recovery_object_progress($1,$2,true,true)", [object.id, object.generation]);
    await db.query("select account_recovery_finish_archival($1)", [a.id]);
  }
  const hash = "f".repeat(64);
  await db.query("select account_recovery_issue_challenge($1,$2,$3)", [requests[0], first.id, hash]);
  const { rows: [claim] } = await db.query<{ id: string }>("select account_recovery_choose($1,$2,$3,'fresh') id", [requests[0], first.id, hash]);
  expect((await db.query("select id from account_recovery_prepare_object_purge($1,$2)", [requests[0], claim.id])).rows).toEqual([{ id: objectId }]);
  await db.query("select account_recovery_issue_challenge($1,$2,$3)", [requests[1], second.id, hash]);
  await db.query("select account_recovery_recover($1,$2,$3)", [requests[1], second.id, hash]);
  expect((await db.query("select state from account_recovery_objects where id=$1", [objectId])).rows[0]).toEqual({ state: "purging" });
});

it.each([false, true])("handles JSON-only financial identity recovery without reversing reassignment=%s", async (reassign) => {
  const manager = await user("manager"), resident = await user("resident"), replacement = await user("resident");
  const id = crypto.randomUUID();
  await db.query("insert into ledger_entries values($1,$2,null,null,125000,$3)", [id, manager.id, { nested: { residentUserId: resident.id, residentEmail: resident.email }, status: "pending" }]);
  const plan = { rules: [{ table: "ledger_entries", ids: ["resident_user_id"], emails: ["resident_email"], retainFinancial: true, recover: true, phase: 1 }], recoverableTables: ["ledger_entries"] };
  const { rows: [a] } = await db.query<{ id: string }>("select account_recovery_begin($1,'resident',$2,'{}') id", [resident.id, plan]);
  await db.query("select account_recovery_finish_archival($1)", [a.id]);
  if (reassign) await db.query("update ledger_entries set row_data=$2 where id=$1", [id, { nested: { residentUserId: replacement.id, residentEmail: replacement.email }, status: "paid" }]);
  else await db.query("update ledger_entries set amount_cents=150000,row_data=jsonb_set(row_data,'{status}','\"paid\"') where id=$1", [id]);
  const hash = "a".repeat(64);
  await db.query("select account_recovery_issue_challenge($1,$2,$3)", [a.id, resident.id, hash]);
  await db.query("select account_recovery_recover($1,$2,$3)", [a.id, resident.id, hash]);
  const row = (await db.query<{ row_data: { nested: { residentUserId: string } }; amount_cents: number }>("select row_data,amount_cents from ledger_entries where id=$1", [id])).rows[0];
  expect(row.row_data.nested.residentUserId).toBe(reassign ? replacement.id : resident.id);
  if (reassign) await expect(db.query("update ledger_entries set resident_user_id=$2 where id=$1", [id, resident.id])).rejects.toThrow(/Deleted resident identity/);
  else {
    expect(row.amount_cents).toBe(150000);
    await db.query("update ledger_entries set resident_user_id=$2 where id=$1", [id, resident.id]);
  }
});

it("keeps a complete-deletion login identity stable and blocks every provisioning role until a choice", async () => {
  const manager = await user("manager");
  await db.query("select account_recovery_begin($1,'manager',$2,'{}')", [manager.id, { complete: true, rules: [], recoverableTables: [] }]);
  await expect(db.query("update auth.users set email='new@example.test' where id=$1", [manager.id])).rejects.toThrow(/recovery decision/);
  await expect(db.query("delete from auth.users where id=$1", [manager.id])).rejects.toThrow(/recovery decision/);
  await expect(db.query("insert into profile_roles values($1,'resident')", [manager.id])).rejects.toThrow(/recovery decision/);
  // Password/login metadata can still change: the retained shell must be usable.
  await db.query("update auth.users set raw_user_meta_data='{}' where id=$1", [manager.id]);
});


it("preserves nullable document links through purge and restores a cyclic version chain", async () => {
  const manager = await user("manager"), first = crypto.randomUUID(), second = crypto.randomUUID();
  await db.query("insert into document_rows values($1,$2,null)", [first, manager.id]);
  await db.query("insert into document_rows values($1,$2,$3)", [second, manager.id, first]);
  await db.query("update document_rows set superseded_id=$2 where id=$1", [first, second]);
  const plan = { rules: [{ table: "document_rows", ids: ["manager_user_id"], recover: true, phase: 3 }], recoverableTables: ["document_rows"] };
  const { rows: [a] } = await db.query<{ id: string }>("select account_recovery_begin($1,'manager',$2,'{}') id", [manager.id, plan]);
  await db.query("delete from document_rows where id=$1", [first]);
  await db.query("delete from document_rows where id=$1", [second]);
  await db.query("select account_recovery_finish_archival($1)", [a.id]);
  const hash = "9".repeat(64);
  await db.query("select account_recovery_issue_challenge($1,$2,$3)", [a.id, manager.id, hash]);
  await db.query("select account_recovery_recover($1,$2,$3)", [a.id, manager.id, hash]);
  expect((await db.query("select superseded_id from document_rows where id=$1", [first])).rows[0]).toEqual({ superseded_id: second });
  expect((await db.query("select superseded_id from document_rows where id=$1", [second])).rows[0]).toEqual({ superseded_id: first });
});

it("creates a new settings generation after recovery without reviving erased settings", async () => {
  await db.exec("create table manager_billing_settings(manager_user_id uuid primary key,enabled boolean)");
  await db.exec("create trigger recovery_settings_guard before insert or update or delete on manager_billing_settings for each row execute function account_recovery_write_guard()");
  const manager = await user("manager");
  const plan = { rules: [{ table: "manager_billing_settings", ids: ["manager_user_id"], recover: false, phase: 1 }] };
  const { rows: [a] } = await db.query<{ id: string }>("select account_recovery_open($1,'manager',$2,'{}') id", [manager.id, plan]);
  const key = { manager_user_id: manager.id };
  await db.query("select account_recovery_add_hold($1,'manager_billing_settings',$2,$3,'delete',false,1)", [a.id, key, { ...key, enabled: true }]);
  await db.query("update account_recovery_records set erased=true,archived=true,payload=null,row_key=null where table_name='manager_billing_settings'");
  await expect(db.query("insert into manager_billing_settings values($1,false)", [manager.id])).rejects.toThrow(/recovery decision/);
  await db.query("update account_recovery_requests set state='restored',decision='recover' where id=$1", [a.id]);
  await db.query("insert into manager_billing_settings values($1,false)", [manager.id]);
  const { rows: [b] } = await db.query<{ id: string }>("select account_recovery_open($1,'manager',$2,'{}') id", [manager.id, plan]);
  await db.query("select account_recovery_add_hold($1,'manager_billing_settings',$2,$3,'delete',false,1)", [b.id, key, { ...key, enabled: false }]);
  expect((await db.query("select erased,payload->>'enabled' enabled from account_recovery_records where table_name='manager_billing_settings' order by erased")).rows).toEqual([
    { erased: false, enabled: "false" }, { erased: true, enabled: null },
  ]);
});

it("keeps a surviving owner's shared private file active during another owner's re-deletion", async () => {
  const manager = await user("manager"), survivor = await user("manager");
  const { rows: [a] } = await db.query<{ id: string }>("select account_recovery_open($1,'manager','{}','{}') id", [manager.id]);
  const { rows: [b] } = await db.query<{ id: string }>("select account_recovery_open($1,'manager','{}','{}') id", [survivor.id]);
  await db.query("update account_recovery_requests set snapshot_complete=true where id=$1", [a.id]);
  const { rows: [record] } = await db.query<{ id: string }>("select account_recovery_add_hold($1,'document_rows',$2,$3,'reference',true,1) id", [b.id, { id: "survivor-file" }, { id: "survivor-file", path: "shared/doc.pdf" }]);
  const { rows: [object] } = await db.query<{ id: string; generation: string }>("select (account_recovery_register_object($1,'manager-documents','shared/doc.pdf','shared%2Fdoc.pdf','')).*", [a.id]);
  await db.query("update account_recovery_objects set state='active',copied=true,source_removed=true where id=$1", [object.id]);
  await db.query("insert into account_recovery_object_records values($1,$2) on conflict do nothing", [object.id, record.id]);
  const { rows: [again] } = await db.query<{ state: string; generation: string }>("select (account_recovery_register_object($1,'manager-documents','shared/doc.pdf','shared%2Fdoc.pdf','')).*", [a.id]);
  expect(again.state).toBe("active");
  expect(again.generation).toBe(object.generation);
});

it("scrubs terminal recovery identity and redundant live snapshots", async () => {
  const manager = await user("manager");
  const { rows: [a] } = await db.query<{ id: string }>("select account_recovery_open($1,'manager','{}',$2) id", [manager.id, { full_name: "Private name" }]);
  const { rows: [record] } = await db.query<{ id: string }>("select account_recovery_add_hold($1,'document_rows',$2,$3,'delete',true,1) id", [a.id, { id: "compact-file" }, { id: "compact-file", personal: "private" }]);
  await db.query("update account_recovery_requests set state='restored',decision='recover' where id=$1", [a.id]);
  await db.query("update account_recovery_holds set decision='recover' where request_id=$1", [a.id]);
  await db.query("select account_recovery_compact_terminal()");
  expect((await db.query("select user_id,email,profile_data,plan from account_recovery_requests where id=$1", [a.id])).rows[0]).toEqual({ user_id: null, email: "", profile_data: null, plan: {} });
  expect((await db.query("select payload from account_recovery_records where id=$1", [record.id])).rows[0]).toEqual({ payload: null });
});
