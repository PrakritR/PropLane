// Local-only SQL rehearsal. Uses an optional PGlite installation; no hosted DB,
// Storage, credentials, applicant data or network clients are involved.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { prepareApplicationNormalizationDatabase } from "./prepare-nonproduction-database.mjs";
const { PGlite } = await import(process.env.SECURITY_PGLITE_MODULE || "@electric-sql/pglite");
const db = new PGlite();
const owner = "11111111-1111-4111-8111-111111111111";
const otherOwner = "22222222-2222-4222-8222-222222222222";
const oldId = "abc123";
const newId = "PROPLANE-ABC123";
const sourcePath = `application/${newId}/legacy.pdf`;
const encryptedPath = `application/${newId}/migration-test.pdf.penc`;
const oldData = { id: oldId, stage: "Submitted", bucket: "pending", application: { idPhotoFront: { path: sourcePath } }, _applicantIdentity: { ciphertext: "old-PK-ciphertext" } };
const expected = { manager_user_id: owner, resident_email: "synthetic@example.test", property_id: "property-a", assigned_property_id: null, row_data: oldData };
const next = { id: newId, ...expected, row_data: { ...oldData, id: newId, _applicantIdentity: { ciphertext: "new-PK-ciphertext" } } };
let checks = 0;
async function seed() {
  await db.exec(`truncate public.application_document_storage_aliases, public.cosigner_submission_records,
    public.screening_orders, public.application_fee_waiver_redemptions, public.manager_application_records cascade;`);
  await db.query("insert into public.manager_application_records (id,manager_user_id,resident_email,property_id,row_data) values ($1,$2,$3,$4,$5)", [oldId, owner, expected.resident_email, expected.property_id, oldData]);
  await db.query("insert into public.application_document_storage_aliases(source_path,application_id,encrypted_path) values ($1,$2,$3)", [sourcePath,oldId,encryptedPath]);
  await db.query("insert into public.cosigner_submission_records(id,signer_app_id,row_data) values ('cosigner-test',$1,$2)", [oldId,{ signerAppId: oldId, dob: "unchanged-co-signer-ciphertext" }]);
  await db.query("insert into public.screening_orders(application_id) values ($1)", [oldId]);
  await db.query("insert into public.application_fee_waiver_redemptions(application_id) values ($1)", [oldId]);
}
async function invoke(overrides = {}) {
  return db.query("select public.normalize_application_record_id($1,$2,$3)", [oldId, overrides.expected ?? expected, overrides.next ?? next]);
}
async function assertOriginal() {
  const rows = await db.query("select id,row_data from public.manager_application_records where id=$1", [oldId]);
  assert.equal(rows.rows.length, 1);
  assert.deepEqual(rows.rows[0].row_data, oldData);
  const alias = (await db.query("select application_id,source_path,encrypted_path from public.application_document_storage_aliases")).rows[0];
  assert.deepEqual(alias, { application_id: oldId, source_path: sourcePath, encrypted_path: encryptedPath });
}
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.manager_application_records(id text primary key,manager_user_id uuid,resident_email text,
      property_id text,assigned_property_id text,row_data jsonb not null,created_at timestamptz default now(),updated_at timestamptz default now());
    create table public.cosigner_submission_records(id text primary key,signer_app_id text,row_data jsonb,updated_at timestamptz);
    create table public.screening_orders(application_id text);
    create table public.application_fee_waiver_redemptions(application_id text);`);
  await db.exec(readFileSync(new URL("../../supabase/migrations/20260906031000_application_document_aliases.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../../supabase/migrations/20260906050000_application_record_normalization.sql", import.meta.url), "utf8"));
  await seed();
  await db.exec("set role service_role");
  await invoke();
  await db.exec("reset role");
  const alias = (await db.query("select * from public.application_document_storage_aliases")).rows[0];
  assert.equal(alias.application_id,newId); assert.equal(alias.source_path,sourcePath); assert.equal(alias.encrypted_path,encryptedPath);
  assert.equal((await db.query("select id from public.manager_application_records where id=$1",[oldId])).rows.length,0);
  assert.deepEqual((await db.query("select row_data from public.manager_application_records where id=$1",[newId])).rows[0].row_data,next.row_data);
  const child = (await db.query("select * from public.cosigner_submission_records")).rows[0];
  assert.equal(child.signer_app_id,newId); assert.equal(child.row_data.signerAppId,newId); assert.equal(child.row_data.dob,"unchanged-co-signer-ciphertext");
  for(const table of ["screening_orders","application_fee_waiver_redemptions"]) assert.equal((await db.query(`select application_id from public.${table}`)).rows[0].application_id,newId);
  checks++;
  await seed();
  await db.query("insert into public.manager_application_records(id,manager_user_id,row_data) values ($1,$2,'{}')",[newId,otherOwner]);
  await assert.rejects(invoke()); await assertOriginal();
  assert.equal((await db.query("select manager_user_id from public.manager_application_records where id=$1",[newId])).rows[0].manager_user_id,otherOwner); checks++;
  await seed();
  await assert.rejects(invoke({ expected: { ...expected, manager_user_id: otherOwner } })); await assertOriginal(); checks++;
  await seed();
  await assert.rejects(invoke({ expected: { ...expected, row_data: { ...oldData, stage: "outdated snapshot" } } })); await assertOriginal(); checks++;
  await seed();
  await assert.rejects(invoke({ next: { ...next,row_data: { ...next.row_data,stage: "In progress" } } })); await assertOriginal(); checks++;
  await seed();
  await db.exec(`create function reject_child_move() returns trigger language plpgsql as $$ begin raise exception 'synthetic child failure'; end $$;
    create trigger reject_child_move before update on public.screening_orders for each row execute function reject_child_move();`);
  await assert.rejects(invoke()); await assertOriginal();
  assert.equal((await db.query("select id from public.manager_application_records where id=$1",[newId])).rows.length,0);
  assert.equal((await db.query("select signer_app_id from public.cosigner_submission_records")).rows[0].signer_app_id,oldId); checks++;
  await db.exec("drop trigger reject_child_move on public.screening_orders");
  for(const role of ["anon","authenticated"]) {
    await db.exec(`set role ${role}`); await assert.rejects(invoke(),/permission denied/); await db.exec("reset role");
  }
  await assertOriginal(); checks++;
  await db.exec(`drop function public.normalize_application_record_id(text,jsonb,jsonb);
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);`);
  const logs = [];
  const config = { ref: "emstjswhotsnyksqhqyf", config: {}, connect: async () => ({ query: (sql, params) => params === undefined ? db.exec(sql).then((results) => results.at(-1) ?? { rows: [] }) : db.query(sql, params), end: async () => {} }), log: (line) => logs.push(JSON.parse(line)) };
  await prepareApplicationNormalizationDatabase({ ...config, apply: false });
  assert.equal(logs.at(-1).after.function_present,false);
  assert.equal((await db.query("select * from supabase_migrations.schema_migrations")).rows.length,0); checks++;
  await prepareApplicationNormalizationDatabase({ ...config, apply: true });
  assert.equal(logs.at(-1).after.historyStatus,"matches"); assert.equal(logs.at(-1).permissionsMeetBoundary,true);
  const history = (await db.query("select * from supabase_migrations.schema_migrations")).rows[0];
  assert.equal(history.version,"20260906050000");
  assert.equal(history.statements[0],readFileSync(new URL("../../supabase/migrations/20260906050000_application_record_normalization.sql",import.meta.url),"utf8")); checks++;
  await db.query("update supabase_migrations.schema_migrations set statements=array['synthetic drift']");
  await assert.rejects(prepareApplicationNormalizationDatabase({ ...config, apply: true }), /history/);
  await assert.rejects(prepareApplicationNormalizationDatabase({ ...config, ref: "qahnczmilgptcedaqype", apply: true }), /Development or staging/); checks++;
  console.log(JSON.stringify({ passed: checks, database: "isolated in-memory PGlite", hostedWrites: false,
    coverage: ["alias/path preservation and parent links", "occupied foreign target", "owner mismatch", "stale snapshot", "draft downgrade", "post-alias failure rollback", "browser RPC denial", "provisioner dry-run", "exact migration history and grants", "history drift and production target denial"],
    limitation: "Single connection. No hosted schema or multi-connection contention claim; cryptographic rekey is covered in unit tests." }));
} finally { await db.close(); }
