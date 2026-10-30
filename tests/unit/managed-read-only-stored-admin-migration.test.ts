import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20261030144500_managed_read_only_stored_admin.sql", "utf8");
const prior = readFileSync("supabase/migrations/20261020190100_first_paid_search_path.sql", "utf8");
describe("managed read-only stored-admin migration", () => {
  it("changes only the email exemption in the existing function", () => {
    const body = (sql: string) => sql.slice(sql.indexOf("create or replace function"));
    const removed = /\n    or exists \(\n      select 1 from public\.profiles p\n      where p\.id = uid\n        and lower\(btrim\(coalesce\(p\.email, ''\)\)\) = 'founders@axis-seattle-housing\.com'\n    \)/;
    expect(removed.test(body(prior))).toBe(true);
    expect(body(migration)).toBe(body(prior).replace(removed, ""));
    expect(migration).toContain("r.role = 'admin'");
    expect(migration).toContain("s.owner_user_id = uid");
    expect(migration).toContain("mp.first_paid_at is not null");
    expect(migration).toContain("revoke all on function public.managed_read_only_owned_locked_ids(uuid) from public, anon, authenticated");
    expect(migration).not.toContain("public.profiles");
  });
});
