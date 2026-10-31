import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("preserves subject on stale upsert and detaches only on Auth deletion", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create schema auth; create role anon; create role authenticated;
      create table auth.users(id uuid primary key);
      create table public.account_recovery_requests(user_id uuid, state text);
      create table public.portal_work_order_records(id text primary key,row_data jsonb not null);
      create table public.portal_service_request_records(id text primary key,row_data jsonb not null);`);
    const sql = readFileSync("supabase/migrations/20261030144600_resident_service_subjects.sql", "utf8");
    await db.exec(sql);
    await db.exec(sql);
    await db.exec(`insert into auth.users values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
      insert into public.portal_work_order_records(id,resident_user_id,row_data) values ('a','00000000-0000-0000-0000-000000000001','{}');
      insert into public.portal_work_order_records(id,row_data) values ('a','{"title":"stale"}')
        on conflict(id) do update set row_data=excluded.row_data,resident_user_id=excluded.resident_user_id;`);
    const stale = (await db.query<{resident_user_id: string; row_revision: number}>("select resident_user_id,row_revision from public.portal_work_order_records where id='a'")).rows[0];
    expect(stale?.resident_user_id).toBe("00000000-0000-0000-0000-000000000001");
    expect(Number(stale?.row_revision)).toBe(2);
    await db.exec("update public.portal_work_order_records set row_revision=0, row_data='{}' where id='a'");
    expect(Number((await db.query<{row_revision:number}>("select row_revision from public.portal_work_order_records where id='a'")).rows[0]?.row_revision)).toBe(3);
    await expect(db.exec("update public.portal_work_order_records set resident_user_id='00000000-0000-0000-0000-000000000002' where id='a'")).rejects.toThrow();
    await db.exec("insert into public.portal_service_request_records(id,row_revision,row_data) values ('null-revision',null,'{}'), ('negative-revision',-9,'{}')");
    const inserted = (await db.query<{row_revision: number}>("select row_revision from public.portal_service_request_records order by id")).rows;
    expect(inserted.map((row) => Number(row.row_revision))).toEqual([1, 1]);
    await db.exec("delete from auth.users where id='00000000-0000-0000-0000-000000000001'");
    const detached = (await db.query<{resident_user_id: string | null; resident_subject_was_bound: boolean}>("select resident_user_id,resident_subject_was_bound from public.portal_work_order_records where id='a'")).rows[0];
    expect(detached).toEqual({ resident_user_id: null, resident_subject_was_bound: true });
    await expect(db.exec("update public.portal_work_order_records set resident_user_id='00000000-0000-0000-0000-000000000002' where id='a'")).rejects.toThrow();
  } finally { await db.close(); }
});
