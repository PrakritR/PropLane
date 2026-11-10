import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20261030010000_deposit_return_reservations.sql", "utf8").toLowerCase();

describe("deposit return reservation migration", () => {
  it("serializes reservation and offline disposition on the same deposit row", () => {
    const reserve = sql.split("create or replace function public.reserve_security_deposit_return(")[1]!.split("end $$;")[0]!;
    const disposition = sql.split("create or replace function public.commit_security_deposit_disposition(")[1]!.split("end $$;")[0]!;
    for (const body of [reserve, disposition]) {
      expect(body).toMatch(/security_deposit_ledger[\s\S]*?for update/);
      expect(body).toContain("status in ('reserved','pending','unknown','succeeded')");
    }
    expect(sql).toMatch(/create unique index if not exists security_deposit_return_one_active[\s\S]*?where deposit_id is not null/);
  });
  it("binds a retry key to exact amounts, itemization and deposit", () => {
    for (const field of ["deposit_id", "manager_user_id", "source_charge_id", "expected_held_cents", "refund_cents", "withhold_cents", "itemization"]) {
      expect(sql).toContain(`a.${field} is distinct from`);
    }
    expect(sql).toContain("item_total <> p_withhold");
  });
  it("denies client access and prevents bypass of the disposition wrapper", () => {
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("revoke all on public.security_deposit_return_attempts from public, anon, authenticated");
    expect(sql).toMatch(/revoke all on function public\.commit_security_deposit_disposition_unreserved[\s\S]*?from public, anon, authenticated, service_role/);
  });
});
