import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve("supabase/migrations/20260916030000_workspace_delete_any.sql"), "utf8");

describe("workspace delete-any migration", () => {
  it("creates the first named workspace as the default instead of seeding a second one", () => {
    expect(sql).not.toMatch(/values \(p_owner, 'My workspace', true\)/);
    expect(sql).toMatch(/insert into public\.portal_workspaces \(owner_user_id, name, is_default\)\s+values \(\s*p_owner,\s*pg_catalog\.btrim\(p_name\),\s*not exists/);
  });

  it("deletes under the owner lock, moves houses to an owner-checked destination, and promotes the oldest remaining default", () => {
    expect(sql).toContain("create or replace function public.delete_portal_workspace(");
    expect((sql.match(/pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\('workspace-owner:' \|\| p_owner::text, 0\)/g) ?? []).length).toBe(2);
    expect(sql).toMatch(/destination_owner is distinct from p_owner/);
    expect(sql).toMatch(/set workspace_id = p_move_to\s+where workspace_id = p_id and manager_user_id = p_owner/);
    expect(sql).toMatch(/if was_default then\s+update public\.portal_workspaces\s+set is_default = true/);
    expect(sql).toMatch(/order by created_at, id\s+limit 1/);
  });

  it("stays service-only and never refers to the default workspace as undeletable", () => {
    expect(sql).toContain("revoke all on function public.delete_portal_workspace(uuid, uuid, uuid) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.delete_portal_workspace(uuid, uuid, uuid) to service_role;");
    expect(sql).toContain("revoke all on function public.create_portal_workspace_with_limit(uuid, text, integer) from public, anon, authenticated;");
    expect(sql).not.toMatch(/must be kept/i);
  });
});
