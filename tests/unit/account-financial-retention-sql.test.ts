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
  for (const table of tables) await db.exec(`create table ${table}(
    id uuid primary key,manager_user_id uuid not null,resident_user_id uuid,
    resident_email text not null,amount numeric not null,row_data jsonb not null);`);
  await db.exec(readFileSync("supabase/migrations/20260907214100_preserve_resident_financial_history.sql", "utf8"));
  for (const table of ["vendor_invoices", "vendor_payouts"]) await db.exec(`create table ${table}(
    id uuid primary key, manager_user_id uuid not null references auth.users(id) on delete cascade,
    vendor_user_id uuid not null references auth.users(id) on delete cascade, amount_cents integer not null);`);
  await db.exec(readFileSync("supabase/migrations/20260907221500_preserve_shared_vendor_financial_history.sql", "utf8"));
}, 30_000);
afterAll(async () => { await db?.close(); });

describe.each(tables)("resident deletion preserves %s", table => {
  it("preserves money and owner, detaches all access keys, and rejects stale identity writes", async () => {
    const id = crypto.randomUUID();
    await db.query(`insert into ${table} values($1,$2,$3,$4,1250,$5)`, [id, manager, resident, email, {
      residentUserId: resident, residentEmail: email,
      payments: [{ amount: 200, resident_email: email }], status: "paid",
    }]);
    const rule = ACCOUNT_PURGE_TABLES.find(rule => rule.table === table)!.resident!;
    await db.query("select account_preserve_financial_records($1,$2,$3,$4,$5)", [table, resident, email.toLowerCase(), rule.ids, rule.emails]);
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
    await db.query("select account_preserve_financial_records($1,$2,$3,$4,$5)", [table, resident, email.toLowerCase(), rule.ids, rule.emails]);
    const { rows } = await db.query(`select * from ${table} where id=any($1::uuid[]) order by amount`, [ids]);
    expect(JSON.stringify(rows[0].row_data)).not.toContain(email);
    expect(rows[1].resident_email).toBe("residentX1anything@example.test");
  });
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
    await expect(db.query(`insert into ${table} values($1,$2,$3,125000)`, [id, replacementId, otherId])).rejects.toThrow(/Deleted resident identity/);
  });
});
