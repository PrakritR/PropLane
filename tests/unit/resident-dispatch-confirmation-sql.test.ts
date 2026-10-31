import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const sql = readFileSync("supabase/migrations/20261030145200_resident_dispatch_confirmation.sql", "utf8");
it("locks lifecycle, subject, exact run and service before updating either row", () => {
  expect(sql).toContain("pg_try_advisory_xact_lock_shared(723081447301::bigint)");
  expect(sql).toContain("resident_user_id=p_resident for update");
  expect(sql).toContain("r.source_type <> 'work_order'");
  expect(sql).toContain("confirmation_applied := true");
  expect(sql).toContain("requested + interval '7 days' >= at_time");
  expect(sql).toContain("grant execute on function public.resolve_resident_dispatch_confirmation(uuid,uuid,uuid,text) to service_role");
  expect(sql).toContain("from public,anon,authenticated");
});

it("rejects terminal services under the row lock before either verdict writes", () => {
  const guard = sql.indexOf("An independently terminal service");
  expect(guard).toBeGreaterThan(sql.indexOf("resident_user_id=p_resident for update"));
  expect(guard).toBeLessThan(sql.indexOf("if p_verdict='fixed' then"));
  expect(sql).toContain("in ('completed','cancelled','canceled')");
  expect(sql).toContain("nullif(w.row_data->>'completedAt','') is not null");
});

it("limits the atomic DONE transition to service role and pins the inspected job", () => {
  expect(sql).toContain("w.resident_user_id is distinct from p_resident or w.row_revision <> p_revision");
  expect(sql).toContain("a.vendor_directory_id is distinct from r.accepted_vendor_directory_id");
  expect(sql).toContain("p_test_session");
  expect(sql).toContain("revoke all on function public.record_vendor_dispatch_done(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text) from public,anon,authenticated");
  expect(sql).toContain("grant execute on function public.record_vendor_dispatch_done(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text) to service_role");
});
