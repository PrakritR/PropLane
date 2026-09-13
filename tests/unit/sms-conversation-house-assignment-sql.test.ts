import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

let db: PGlite;
const owner = "00000000-0000-0000-0000-000000000001";
const actor = "00000000-0000-0000-0000-000000000002";
const stranger = "00000000-0000-0000-0000-000000000003";
const key = `${owner}:prospect:+12065550100`;
const member = `${owner}:resident:resident-id`;
const expected = [{ conversation_key: key, property_id: "a" }];
const migration = readFileSync("supabase/migrations/20260912210000_atomic_conversation_house_assignment.sql", "utf8");

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table profiles(id uuid primary key, email text);
    create table account_link_invites(id text primary key, inviter_user_id uuid, invitee_user_id uuid, status text, assigned_property_ids text[], property_co_manager_permissions jsonb);
    create table manager_property_records(id text primary key, manager_user_id uuid);
    create table manager_sms_conversation_houses(manager_user_id uuid not null, conversation_key text not null, property_id text not null, source text not null, tagged_by_user_id uuid, primary key(conversation_key,property_id));
  `);
  await db.exec(migration);
  await db.exec(migration); // Re-application must preserve restricted execution.
}, 30_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("truncate profiles, account_link_invites, manager_property_records, manager_sms_conversation_houses");
  await db.query("insert into profiles values ($1,'owner@example.test'),($2,'actor@example.test'),($3,'other@example.test')", [owner, actor, stranger]);
  await db.query("insert into manager_property_records values ('a',$1),('b',$1),('foreign',$2)", [owner, stranger]);
  await db.query("insert into account_link_invites values ('link',$1,$2,'accepted',array['a','b'],$3)", [owner, actor, { a: { inbox: true }, b: { inbox: true } }]);
  await db.query("insert into manager_sms_conversation_houses values ($1,$2,'a','tour',null)", [owner, key]);
});
async function revision() {
  return (await db.query<{ revision: string }>("select conversation_house_access_revision($1) revision", [actor])).rows[0].revision;
}
async function tags() {
  return (await db.query("select conversation_key,property_id,source from manager_sms_conversation_houses order by conversation_key,property_id")).rows;
}
async function replace(next: string[] | null, rev: string, old = expected, keys: string[] | null = [key, member]) {
  return (await db.query<{ ok: boolean }>("select replace_conversation_houses($1,$2,$3,$4,$5,$6,$7) ok", [owner, actor, key, keys, next, JSON.stringify(old), rev])).rows[0].ok;
}

it("atomically replaces all persisted member tags with one canonical assignment", async () => {
  await db.query("insert into manager_sms_conversation_houses values ($1,$2,'a','residency',null)", [owner, member]);
  const old = [...expected, { conversation_key: member, property_id: "a" }].sort((a,b) => a.conversation_key.localeCompare(b.conversation_key));
  expect(await replace(["b"], await revision(), old)).toBe(true);
  expect(await tags()).toEqual([{ conversation_key: key, property_id: "b", source: "manual" }]);
});
it.each(["foreign", "missing"])("rejects an unowned next house %s even when owner owns another house", async (id) => {
  expect(await replace([id], await revision())).toBe(false);
  expect(await tags()).toEqual([{ conversation_key: key, property_id: "a", source: "tour" }]);
});
it.each([
  "update account_link_invites set status='cancelled'",
  "update account_link_invites set property_co_manager_permissions='{}'",
  "update manager_property_records set manager_user_id='00000000-0000-0000-0000-000000000003' where id='b'",
  "insert into manager_property_records values ('new-house','00000000-0000-0000-0000-000000000001')",
  "update profiles set email='seed@test.proplane.local' where id='00000000-0000-0000-0000-000000000002'",
])("rejects stale access after %s", async (mutation) => {
  const rev = await revision();
  await db.exec(mutation);
  expect(await replace(["b"], rev)).toBe(false);
  expect(await tags()).toEqual([{ conversation_key: key, property_id: "a", source: "tour" }]);
});
it("preserves concurrent automatic tags that were absent from the authorization snapshot", async () => {
  const rev = await revision();
  await db.query("insert into manager_sms_conversation_houses values ($1,$2,'b','tour',null)", [owner, key]);
  expect(await replace(["a"], rev)).toBe(false);
  expect(await tags()).toHaveLength(2);
});
it("rolls back the deletion if an insertion fails", async () => {
  await expect(replace(["b", "b"], await revision())).rejects.toThrow(/duplicate key/i);
  expect(await tags()).toEqual([{ conversation_key: key, property_id: "a", source: "tour" }]);
});
it("permits an explicitly authorized clear", async () => {
  expect(await replace([], await revision())).toBe(true);
  expect(await tags()).toEqual([]);
});
it("rejects null arrays and canonical keys missing from members", async () => {
  const rev = await revision();
  expect(await replace(null, rev)).toBe(false);
  expect(await replace(["b"], rev, expected, null)).toBe(false);
  expect(await replace(["b"], rev, expected, [member])).toBe(false);
  expect(await tags()).toEqual([{ conversation_key: key, property_id: "a", source: "tour" }]);
});
it.each(["anon", "authenticated"])("does not expose either RPC to %s", async (role) => {
  const result = await db.query<{ revision: boolean; replacement: boolean }>(`select
    has_function_privilege($1, 'conversation_house_access_revision(uuid)', 'execute') revision,
    has_function_privilege($1, 'replace_conversation_houses(uuid,uuid,text,text[],text[],jsonb,text)', 'execute') replacement`, [role]);
  expect(result.rows).toEqual([{ revision: false, replacement: false }]);
});
