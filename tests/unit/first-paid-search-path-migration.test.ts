import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(process.cwd(), "supabase", "migrations");
const read = (name: string) => readFileSync(join(dir, name), "utf8");
const fnOf = (sql: string) => sql.slice(sql.indexOf("create or replace function public.managed_read_only_owned_locked_ids"));

describe("20261020190100_first_paid_search_path", () => {
  const next = read("20261020190100_first_paid_search_path.sql");
  const prev = read("20261020140000_manager_purchase_first_paid.sql");

  it("re-creates the security definer function with pg_temp pinned last", () => {
    expect(next).toMatch(/security definer\s+set search_path = public, pg_temp\s+as \$\$/);
    expect(next).not.toMatch(/set search_path = public\s*\n/);
  });

  it("keeps the body and the revoke identical to the applied migration", () => {
    expect(fnOf(next).replace("public, pg_temp", "public")).toBe(fnOf(prev));
    expect(next).toContain("revoke all on function public.managed_read_only_owned_locked_ids(uuid) from public, anon, authenticated;");
  });

  it("leaves the applied migration untouched", () => {
    expect(prev).toContain("set search_path = public\n");
    expect(prev).not.toContain("pg_temp");
  });
});
