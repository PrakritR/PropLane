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

describe("20261021090000_managed_read_only_search_path_siblings", () => {
  const next = read("20261021090000_managed_read_only_search_path_siblings.sql");
  const prev = read("20261019120000_managed_read_only_v2.sql");
  /** One `create or replace function ... $$;` block by name. */
  const bodyOf = (sql: string, name: string) => {
    const at = sql.indexOf(`create or replace function public.${name}`);
    const end = sql.indexOf("$$;", at);
    return sql.slice(at, end + 3);
  };

  it("pins pg_temp last on BOTH siblings of the family", () => {
    for (const name of ["managed_read_only_workspace_ids", "managed_read_only_owner_locked"]) {
      expect(bodyOf(next, name)).toContain("set search_path = public, pg_temp");
    }
    expect(next).not.toMatch(/set search_path = public\s*\n/);
  });

  it("keeps each body and its grants identical to the applied definition", () => {
    for (const name of ["managed_read_only_workspace_ids", "managed_read_only_owner_locked"]) {
      expect(bodyOf(next, name).replace("public, pg_temp", "public")).toBe(bodyOf(prev, name));
      expect(next).toContain(`revoke all on function public.${name}() from public, anon;`);
      expect(next).toContain(`grant execute on function public.${name}() to authenticated;`);
    }
  });
});
