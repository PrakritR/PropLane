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
