import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
describe("admin authority after revocation", () => {
  it("uses stored roles in current authorization paths and recovery SQL", () => {
    const admin = read("src/lib/auth/admin-role.ts");
    const portal = read("src/lib/auth/portal-access.ts");
    const guard = read("src/lib/admin/admin-route-guard.server.ts");
    const recovery = read("supabase/migrations/20261030145000_recovery_stored_roles_only.sql");
    expect(admin).toContain('.from("profile_roles")');
    expect(admin).not.toMatch(/user_metadata|profiles\.role/);
    expect(portal).toContain("ctx.roles.includes(role)");
    expect(guard).toContain("isAdminUser(user.id)");
    expect(recovery).not.toMatch(/insert\s+into\s+public\.profile_roles/i);
  });
  it("keeps the atomic admin operation service-only and lifecycle serialized", () => {
    const sql = read("supabase/migrations/20261030145100_admin_team_atomic_revoke.sql");
    expect(sql).toContain("pg_advisory_xact_lock(723081447301::bigint)");
    expect(sql).toContain("from public,anon,authenticated");
    expect(sql).toContain("to service_role");
    expect(sql).toContain("set search_path = ''");
  });
});
