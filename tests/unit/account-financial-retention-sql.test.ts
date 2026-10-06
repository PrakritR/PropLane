import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { ACCOUNT_PURGE_TABLES } from "@/lib/auth/account-purge-manifest";

const tables = ACCOUNT_PURGE_TABLES.filter(rule => rule.resident?.preserveFinancial).map(rule => rule.table);
let db: PGlite;
const resident = "00000000-0000-4000-8000-000000000001";
const manager = "00000000-0000-4000-8000-000000000002";
const email = "Resident_1%literal@Example.test";

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create table audit_log(id uuid primary key,actor_user_id uuid not null);`);
  for (const table of tables.filter(table => !["application_fee_payment_claims", "resident_checkout_attempts"].includes(table))) await db.exec(`create table ${table}(
    id uuid primary key,manager_user_id uuid not null,resident_user_id uuid,
    resident_email text not null,amount numeric not null,row_data jsonb not null);`);
  await db.exec(readFileSync("supabase/migrations/20260907214100_preserve_resident_financial_history.sql", "utf8"));
  for (const table of ["vendor_invoices", "vendor_payouts"]) await db.exec(`create table ${table}(
    id uuid primary key, manager_user_id uuid not null references auth.users(id) on delete cascade,
    vendor_user_id uuid not null references auth.users(id) on delete cascade, amount_cents integer not null);`);
  await db.exec(readFileSync("supabase/migrations/20260907221500_preserve_shared_vendor_financial_history.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20260907231000_account_recovery_financial_access_keys.sql", "utf8"));
  await db.exec("create table manager_application_records(id text primary key)");
  await db.exec(readFileSync("supabase/migrations/20261004224000_application_fee_payment_claims.sql", "utf8"));
  const claimRetention = readFileSync("supabase/migrations/20261004232000_application_fee_claim_retention.sql", "utf8");
  await db.exec(claimRetention);
  await db.exec(claimRetention);
}, 30_000);
afterAll(async () => { await db?.close(); });

describe.each(tables.filter(table => !["application_fee_payment_claims", "resident_checkout_attempts"].includes(table)))("resident deletion preserves %s", table => {
  it("preserves money and owner, detaches all access keys, and rejects stale identity writes", async () => {
    const id = crypto.randomUUID();
    await db.query(`insert into ${table} values($1,$2,$3,$4,1250,$5)`, [id, manager, resident, email, {
      residentUserId: resident, residentEmail: email,
      payments: [{ amount: 200, resident_email: email }], status: "paid",
    }]);
    const rule = ACCOUNT_PURGE_TABLES.find(rule => rule.table === table)!.resident!;
    await db.query("select account_preserve_financial_records($1,$2,$3,$4,$5)", [table, resident, email.toLowerCase(), rule.ids ?? [], rule.emails ?? []]);
    const { rows: [row] } = await db.query<Record<string, unknown>>(`select * from ${table} where id=$1`, [id]);
    expect(row.manager_user_id).toBe(manager);
    expect(row.amount).toBe("1250");
    expect(row.resident_user_id).toBeNull();
    expect(row.resident_email).toMatch(/^deleted-.+@deleted.invalid$/);
    expect(row.row_data).toMatchObject({ status: "paid", payments: [{ amount: 200 }] });
    expect(JSON.stringify(row)).not.toContain(email);
    expect(JSON.stringify(row.row_data)).not.toContain(resident);
    const freshResident = crypto.randomUUID();
    await db.query("insert into auth.users values($1,$2)", [freshResident, email]);
    await expect(db.query(`update ${table} set resident_user_id=$2 where id=$1`, [id, freshResident])).rejects.toThrow(/Deleted resident identity/);
    // An unrelated manager update is allowed. Deletion is not balance cancellation.
    await db.query(`update ${table} set amount=1400 where id=$1`, [id]);
    await expect(db.query(`update ${table} set resident_email=$2 where id=$1`, [id, email])).rejects.toThrow(/Deleted resident identity/);
    await expect(db.query(`update ${table} set row_data=jsonb_set(row_data,'{residentUserId}',to_jsonb($2::text)) where id=$1`, [id, resident])).rejects.toThrow(/Deleted resident identity/);
    await expect(db.query(`update ${table} set id=$2,resident_email=$3 where id=$1`, [id, crypto.randomUUID(), email])).rejects.toThrow(/identity cannot be changed/);
    expect((await db.query(`select amount from ${table} where id=$1`, [id])).rows[0].amount).toBe("1400");
    await db.query(`delete from ${table} where id=$1`, [id]);
    await expect(db.query(`insert into ${table} values($1,$2,$3,$4,1250,'{}')`, [id, manager, resident, email])).rejects.toThrow(/Deleted resident identity/);
  });

  it("matches JSON-only legacy identities literally and leaves another resident untouched", async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    await db.query(`insert into ${table} values($1,$3,null,'',800,$4),($2,$3,null,'residentX1anything@example.test',900,'{}')`,
      [ids[0], ids[1], manager, { residentEmail: email }]);
    const rule = ACCOUNT_PURGE_TABLES.find(rule => rule.table === table)!.resident!;
    await db.query("select account_preserve_financial_records($1,$2,$3,$4,$5)", [table, resident, email.toLowerCase(), rule.ids ?? [], rule.emails ?? []]);
    const { rows } = await db.query(`select * from ${table} where id=any($1::uuid[]) order by amount`, [ids]);
    expect(JSON.stringify(rows[0].row_data)).not.toContain(email);
    expect(rows[1].resident_email).toBe("residentX1anything@example.test");
  });
});

it("detaches a real application-fee claim without an id or row_data column and blocks stale replay", async () => {
  const residentId = crypto.randomUUID();
  const managerId = crypto.randomUUID();
  const applicationId = `PROPLANE-${crypto.randomUUID()}`;
  const residentEmail = `claim-${crypto.randomUUID()}@example.test`;
  await db.query("insert into auth.users(id,email) values($1,$2),($3,$4)", [
    residentId, residentEmail, managerId, `manager-${managerId}@example.test`,
  ]);
  const terms = { residentEmail, amountCents: 5000, metadata: { application_id: applicationId, resident_email: residentEmail } };
  await db.query(`insert into application_fee_payment_claims(
    application_id,manager_user_id,property_id,resident_email,charge_id,
    stripe_session_id,stripe_charge_id,principal_cents,processing_fee_cents,
    payer_total_cents,recipient_net_cents,provider_params,draft_updated_at,charge_policy,status
  ) values($1,$2,'property-1',$3,$4,'cs_paid','ch_paid',5000,150,5150,5000,$5,now(),'every_time','settled')`,
  [applicationId, managerId, residentEmail, `hc_${applicationId}`, terms]);

  // An existing tombstone exercises the empty id_columns conflict path.
  const { rows: [initialTombstone] } = await db.query<{ marker_id: string }>(`insert into account_deleted_record_identities(
    table_name,record_id,identity_hashes,id_columns,email_columns
  ) values('application_fee_payment_claims',$1,array[account_identity_hash($2)],'{}','{}') returning marker_id`,
  [applicationId, residentEmail]);
  const { rows: [preserved] } = await db.query<{ account_preserve_financial_records: number }>(
    "select account_preserve_financial_records($1,$2,$3,$4,$5)",
    ["application_fee_payment_claims", residentId, residentEmail, [], ["resident_email"]],
  );
  expect(preserved.account_preserve_financial_records).toBe(1);
  const { rows: [replayedPurge] } = await db.query<{ account_preserve_financial_records: number }>(
    "select account_preserve_financial_records($1,$2,$3,$4,$5)",
    ["application_fee_payment_claims", residentId, residentEmail, [], ["resident_email"]],
  );
  expect(replayedPurge.account_preserve_financial_records).toBe(0);
  await db.query("delete from auth.users where id=$1", [residentId]);
  const { rows: [claim] } = await db.query<Record<string, unknown>>(
    "select * from application_fee_payment_claims where application_id=$1", [applicationId]);
  expect(claim).toMatchObject({
    application_id: applicationId, manager_user_id: managerId, property_id: "property-1",
    charge_id: `hc_${applicationId}`, stripe_session_id: "cs_paid", stripe_charge_id: "ch_paid",
    principal_cents: 5000, processing_fee_cents: 150, payer_total_cents: 5150,
    recipient_net_cents: 5000, provider_params: terms, status: "settled",
  });
  expect(claim.resident_email).toMatch(/^deleted-.+@deleted.invalid$/);
  const { rows: [tombstone] } = await db.query<{ marker_id: string; id_columns: string[]; email_columns: string[] }>(
    "select marker_id,id_columns,email_columns from account_deleted_record_identities where table_name='application_fee_payment_claims' and record_id=$1",
    [applicationId],
  );
  expect(tombstone).toMatchObject({ marker_id: initialTombstone.marker_id, id_columns: [], email_columns: ["resident_email"] });
  await expect(db.query("update application_fee_payment_claims set resident_email=$2 where application_id=$1",
    [applicationId, residentEmail])).rejects.toThrow(/Deleted resident identity/);
  await expect(db.query("update application_fee_payment_claims set application_id=$2 where application_id=$1",
    [applicationId, `PROPLANE-${crypto.randomUUID()}`])).rejects.toThrow(/identity cannot be changed/);
  await db.query("delete from application_fee_payment_claims where application_id=$1", [applicationId]);
  await expect(db.query(`insert into application_fee_payment_claims(
    application_id,manager_user_id,property_id,resident_email,charge_id,
    principal_cents,processing_fee_cents,payer_total_cents,recipient_net_cents,
    provider_params,draft_updated_at,charge_policy
  ) values($1,$2,'property-1',$3,$4,5000,150,5150,5000,$5,now(),'every_time')`,
  [applicationId, managerId, residentEmail, `hc_${applicationId}`, terms])).rejects.toThrow(/Deleted resident identity/);
});

it("retains a real resident checkout attempt through resident deletion and cascades its identity-free slot", async () => {
  const exactDb = new PGlite();
  try {
    await exactDb.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key,email text);
      create table audit_log(id uuid primary key,actor_user_id uuid not null);
      create table ledger_entries(id uuid primary key,manager_user_id uuid,resident_user_id uuid,resident_email text,row_data jsonb);
      create table security_deposit_ledger(id uuid primary key,manager_user_id uuid,resident_user_id uuid,resident_email text,row_data jsonb);
      create table manager_payment_plans(id uuid primary key,manager_user_id uuid,resident_user_id uuid,resident_email text,row_data jsonb);
      create table portal_household_charge_records(id text primary key,manager_user_id uuid,resident_user_id uuid,resident_email text,
        property_id text,kind text,status text,row_data jsonb,updated_at timestamptz default now());
      create table portal_lease_pipeline_records(id uuid primary key,manager_user_id uuid,resident_user_id uuid,resident_email text,row_data jsonb);
      create table manager_property_records(id text primary key,manager_user_id uuid);
      create table resident_autopay_runs(id uuid primary key,charge_id text,resident_user_id uuid,manager_id uuid,status text,stripe_payment_intent_id text);`);
    await exactDb.exec(readFileSync("supabase/migrations/20260907214100_preserve_resident_financial_history.sql", "utf8"));
    for (const table of ["vendor_invoices", "vendor_payouts"]) await exactDb.exec(`create table ${table}(
      id uuid primary key, manager_user_id uuid not null references auth.users(id) on delete cascade,
      vendor_user_id uuid not null references auth.users(id) on delete cascade, amount_cents integer not null);`);
    await exactDb.exec(readFileSync("supabase/migrations/20260907221500_preserve_shared_vendor_financial_history.sql", "utf8"));
    await exactDb.exec(readFileSync("supabase/migrations/20260907231000_account_recovery_financial_access_keys.sql", "utf8"));
    await exactDb.exec(readFileSync("supabase/migrations/20261004230000_resident_checkout_attempt_claims.sql", "utf8"));
    const repair = readFileSync("supabase/migrations/20261004232000_application_fee_claim_retention.sql", "utf8");
    await exactDb.exec(`create table application_fee_payment_claims(application_id text primary key, resident_email text)`);
    await exactDb.exec(repair);
    await exactDb.exec(repair);
    const managerId = crypto.randomUUID();
    const residentId = crypto.randomUUID();
    const residentEmail = `resident-${residentId}@example.test`;
    const chargeId = `hc_${crypto.randomUUID()}`;
    const token = crypto.randomUUID();
    await exactDb.query("insert into auth.users(id,email) values($1,$2),($3,$4)",
      [managerId, `manager-${managerId}@example.test`, residentId, residentEmail]);
    await exactDb.query(`insert into portal_household_charge_records
      (id,manager_user_id,resident_user_id,resident_email,property_id,kind,status,row_data)
      values($1,$2,$3,$4,'property-1','rent','pending',$5)`,
      [chargeId, managerId, residentId, residentEmail, {
        id: chargeId, managerUserId: managerId, residentUserId: residentId,
        residentEmail, propertyId: "property-1", kind: "rent", status: "pending",
        amountLabel: "$10.00", balanceLabel: "$10.00",
      }]);
    const terms = { residentEmail, metadata: { resident_attempt_token: token }, amountCents: 1000 };
    const { rows: [attempt] } = await exactDb.query<{ id: string }>(`insert into resident_checkout_attempts(
      attempt_token,resident_user_id,resident_email,manager_user_id,charge_ids,charge_cents,
      subtotal_cents,payer_total_cents,recipient_net_cents,payment_method,provider_params,
      stripe_session_id,status
    ) values($1,$2,$3,$4,$5,$6,1000,1000,1000,'card',$7,'cs_delayed','pending') returning id`,
    [token, residentId, residentEmail, managerId, [chargeId], [1000], terms]);
    await exactDb.query("insert into resident_charge_payment_slots(charge_id,checkout_attempt_id) values($1,$2)",
      [chargeId, attempt.id]);
    const count = await exactDb.query<{ account_preserve_financial_records: number }>(
      "select account_preserve_financial_records($1,$2,$3,$4,$5)",
      ["resident_checkout_attempts", residentId, residentEmail, ["resident_user_id"], ["resident_email"]]);
    expect(count.rows[0].account_preserve_financial_records).toBe(1);
    const chargeCount = await exactDb.query<{ account_preserve_financial_records: number }>(
      "select account_preserve_financial_records($1,$2,$3,$4,$5)",
      ["portal_household_charge_records", residentId, residentEmail, ["resident_user_id"], ["resident_email"]]);
    expect(chargeCount.rows[0].account_preserve_financial_records).toBe(1);
    await exactDb.query("delete from auth.users where id=$1", [residentId]);
    const { rows: [saved] } = await exactDb.query<Record<string, unknown>>(
      "select * from resident_checkout_attempts where id=$1", [attempt.id]);
    expect(saved).toMatchObject({ resident_user_id: null, manager_user_id: managerId,
      subtotal_cents: 1000, payer_total_cents: 1000, recipient_net_cents: 1000,
      charge_ids: [chargeId], provider_params: terms, status: "pending" });
    expect(saved.resident_email).toMatch(/^deleted-.+@deleted.invalid$/);
    await expect(exactDb.query("update resident_checkout_attempts set resident_email=$2 where id=$1",
      [attempt.id, residentEmail])).rejects.toThrow(/Deleted resident identity/);
    const replacementId = crypto.randomUUID();
    await exactDb.query("insert into auth.users(id,email) values($1,$2)", [replacementId, residentEmail]);
    await expect(exactDb.query("update resident_checkout_attempts set resident_user_id=$2 where id=$1",
      [attempt.id, replacementId])).rejects.toThrow(/Deleted resident identity/);
    const delayed = await exactDb.query<{ result: { rows: Array<Record<string, unknown>>; newlySettled: boolean } }>(
      "select settle_resident_checkout_attempt($1,$2,'cs_delayed','pi_delayed') as result",
      [attempt.id, token]);
    expect(delayed.rows[0].result.newlySettled).toBe(true);
    expect(delayed.rows[0].result.rows[0]).toMatchObject({
      id: chargeId, status: "paid", paidAmountCents: 1000, balanceLabel: "$0.00",
    });
    expect((await exactDb.query("select resident_user_id,resident_email from resident_checkout_attempts where id=$1",
      [attempt.id])).rows[0]).toMatchObject({ resident_user_id: null, resident_email: saved.resident_email });
    await exactDb.query("delete from resident_checkout_attempts where id=$1", [attempt.id]);
    expect((await exactDb.query("select * from resident_charge_payment_slots where charge_id=$1", [chargeId])).rows).toEqual([]);
  } finally {
    await exactDb.close();
  }
});

it("does not expose the preservation RPC or identity hashes to browser roles", async () => {
  const { rows: [row] } = await db.query(`select
    has_table_privilege('authenticated','account_deleted_record_identities','SELECT') as can_read,
    has_function_privilege('authenticated','account_preserve_financial_records(text,text,text,text[],text[])','EXECUTE') as can_call`);
  expect(row).toEqual({ can_read: false, can_call: false });
});


describe.each(["vendor_invoices", "vendor_payouts"])("shared vendor financial history: %s", table => {
  it.each(["manager", "vendor"] as const)("preserves the surviving account when %s deletes first", async first => {
    const managerId = crypto.randomUUID();
    const vendorId = crypto.randomUUID();
    const id = crypto.randomUUID();
    await db.query("insert into auth.users values($1,$3),($2,$4)", [managerId, vendorId, `${managerId}@test.invalid`, `${vendorId}@test.invalid`]);
    await db.query(`insert into ${table} values($1,$2,$3,125000)`, [id, managerId, vendorId]);
    const firstId = first === "manager" ? managerId : vendorId;
    const otherId = first === "manager" ? vendorId : managerId;
    const firstColumn = `${first}_user_id`;
    const otherColumn = first === "manager" ? "vendor_user_id" : "manager_user_id";
    await db.query("select account_preserve_financial_records($1,$2,$3,$4,'{}')", [table, firstId, `${firstId}@test.invalid`, [firstColumn]]);
    await db.query("delete from auth.users where id=$1", [firstId]);
    expect((await db.query(`select * from ${table} where id=$1`, [id])).rows[0]).toMatchObject({
      [firstColumn]: null, [otherColumn]: otherId, amount_cents: 125000,
    });
    const replacementId = crypto.randomUUID();
    await db.query("insert into auth.users values($1,$2)", [replacementId, `${firstId}@test.invalid`]);
    await expect(db.query(`update ${table} set ${firstColumn}=$2 where id=$1`, [id, replacementId])).rejects.toThrow(/Deleted resident identity/);
    await db.query("select account_preserve_financial_records($1,$2,$3,$4,'{}')", [table, otherId, `${otherId}@test.invalid`, [otherColumn]]);
    expect((await db.query(`select * from ${table} where id=$1`, [id])).rows).toEqual([]);
    const otherReplacementId = crypto.randomUUID();
    await db.query("insert into auth.users values($1,$2)", [otherReplacementId, `${otherId}@test.invalid`]);
    const replayManagerId = first === "manager" ? replacementId : otherReplacementId;
    const replayVendorId = first === "vendor" ? replacementId : otherReplacementId;
    await expect(db.query(`insert into ${table} values($1,$2,$3,125000)`,
      [id, replayManagerId, replayVendorId])).rejects.toThrow(/Deleted resident identity/);
  });
});
