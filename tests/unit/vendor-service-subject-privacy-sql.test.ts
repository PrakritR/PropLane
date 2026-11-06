import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("removes direct vendor table reads without changing service-role access", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role authenticated; create role service_role bypassrls;
      create table public.portal_work_order_records(id text primary key, vendor_user_id text, resident_user_id text, row_data jsonb);
      alter table public.portal_work_order_records enable row level security;
      grant select on public.portal_work_order_records to authenticated, service_role;
      create policy portal_work_order_records_vendor_read on public.portal_work_order_records for select to authenticated using (vendor_user_id = 'vendor');
      insert into public.portal_work_order_records values ('a','vendor','private-resident','{"residentUserId":"private-resident"}');`);
    await db.exec("set role authenticated");
    expect((await db.query("select * from public.portal_work_order_records")).rows).toHaveLength(1);
    await db.exec("reset role");
    const sql = readFileSync("supabase/migrations/20261030144700_vendor_service_subject_privacy.sql", "utf8");
    await db.exec(sql); await db.exec(sql);
    await db.exec("set role authenticated");
    expect((await db.query("select * from public.portal_work_order_records")).rows).toHaveLength(0);
    await db.exec("reset role; set role service_role");
    expect((await db.query("select * from public.portal_work_order_records")).rows).toHaveLength(1);
  } finally { await db.close(); }
});
