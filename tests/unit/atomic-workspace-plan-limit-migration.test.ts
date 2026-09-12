import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260913001000_atomic_workspace_plan_limit.sql",
  "utf8",
);
const workspaceMigration = readFileSync(
  "supabase/migrations/20260912201050_manager_plan_addons.sql",
  "utf8",
);

const functionMatch = migration.match(
  /create or replace function public\.create_portal_workspace_with_limit\(\s*p_owner uuid,\s*p_name text,\s*p_limit integer\s*\).*?as \$\$(.*?)\$\$/is,
);

describe("atomic workspace plan-limit RPC migration", () => {
  it("defines the pinned owner/name/limit RPC as a service-only security definer", () => {
    expect(functionMatch).not.toBeNull();
    expect(migration).toMatch(
      /create or replace function public\.create_portal_workspace_with_limit\(\s*p_owner uuid,\s*p_name text,\s*p_limit integer\s*\)\s*returns uuid\s+language plpgsql\s+security definer\s+set search_path\s*=\s*''/is,
    );
    expect(migration).toMatch(
      /revoke all on function public\.create_portal_workspace_with_limit\(uuid,\s*text,\s*integer\) from public,\s*anon,\s*authenticated;/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.create_portal_workspace_with_limit\(uuid,\s*text,\s*integer\) to service_role;/i,
    );
  });

  it("validates the database ceiling and name before insertion", () => {
    const body = functionMatch?.[1] ?? "";
    expect(body).toMatch(/p_limit\s+is\s+null|p_limit\s*<\s*1/i);
    expect(body).toMatch(/p_limit\s*>\s*10/i);
    expect(body).toMatch(/btrim\(p_name\)/i);
    expect(body).toMatch(/(?:pg_catalog\.)?length\(\s*(?:pg_catalog\.)?btrim\(p_name\)\)/i);
    expect(body).toMatch(/public\.portal_workspaces/i);
  });

  it("counts and inserts while holding the same workspace-owner lock as the trigger", () => {
    const body = functionMatch?.[1] ?? "";
    expect(body).toMatch(/pg_advisory_xact_lock\s*\(\s*(?:pg_catalog\.)?hashtextextended\(\s*'workspace-owner:'\s*\|\|\s*p_owner::text\s*,\s*0\s*\)\s*\)/i);
    expect(body).toMatch(/select\s+count\(\*\)(?:::\s*integer)?\s+into\s+\w+\s+from\s+public\.portal_workspaces\s+where\s+owner_user_id\s*=\s*p_owner/i);
    expect(body).toMatch(/insert\s+into\s+public\.portal_workspaces/i);
    expect(workspaceMigration).toMatch(/pg_advisory_xact_lock\s*\(\s*(?:pg_catalog\.)?hashtextextended\(\s*'workspace-owner:'\s*\|\|\s*new\.owner_user_id::text/i);
  });

  it("does not grant client execution or rely on unqualified workspace objects", () => {
    const body = functionMatch?.[1] ?? "";
    expect(body).toMatch(/pg_catalog\.length\(\s*pg_catalog\.btrim\(p_name\)\)/i);
    expect(body).toMatch(/pg_catalog\.pg_advisory_xact_lock\(/i);
    expect(body).toMatch(/pg_catalog\.hashtextextended\(/i);
    expect(body).not.toMatch(/\bfrom\s+portal_workspaces\b/i);
    expect(body).not.toMatch(/\binsert\s+into\s+portal_workspaces\b/i);
    expect(migration).not.toMatch(/grant execute on function public\.create_portal_workspace_with_limit[^;]*to (public|anon|authenticated)/i);
  });
});
