import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const original = readFileSync(
  resolve("supabase/migrations/20260913170000_mark_portal_inbox_source_read.sql"),
  "utf8",
);
const corrected = readFileSync(
  resolve("supabase/migrations/20260919120000_mark_portal_inbox_source_read_resident_scope.sql"),
  "utf8",
);
const compact = (sql: string) => sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").toLowerCase();

describe("resident inbox source-read migration", () => {
  it("keeps the original manager-only behavior as the regression fixture", () => {
    const sql = compact(original);
    expect(sql).toContain("scope = 'axis_portal_inbox_manager_v1' and scope = p_scope");
    expect(sql).not.toContain("axis_portal_inbox_resident_v1");
  });

  it("allows exactly manager and resident scopes with an exact p_scope match", () => {
    const sql = compact(corrected);
    expect(sql).toContain(
      "scope in ('axis_portal_inbox_manager_v1', 'axis_portal_inbox_resident_v1')",
    );
    expect(sql).toContain("and scope = p_scope");
    expect(sql).not.toMatch(/scope\s+in\s*\([^)]*vendor|scope\s+in\s*\([^)]*admin/);
  });

  it("retains the snapshot CAS, ownership, folder, unread, and timestamp fences", () => {
    const sql = compact(corrected);
    for (const fragment of [
      "p_id <> '' and id = p_id",
      "p_owner_user_id is not null and owner_user_id = p_owner_user_id",
      "owner_user_id = p_owner_user_id",
      "participant_email is not distinct from p_participant_email",
      "thread_type is not distinct from p_thread_type",
      "p_updated_at is not null and updated_at = p_updated_at",
      "pg_catalog.jsonb_typeof(p_row_data) = 'object' and row_data = p_row_data",
      "row_data->'folder' in ('\"inbox\"'::jsonb, '\"sent\"'::jsonb)",
      "row_data->'unread' = 'true'::jsonb",
      "updated_at = greatest(pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond')",
    ]) {
      expect(sql).toContain(fragment);
    }
  });

  it("preserves invoker mode, empty search_path, and service-role-only execution", () => {
    const sql = compact(corrected);
    expect(sql).toContain("language sql volatile security invoker set search_path = ''");
    expect(sql).toContain(
      "revoke all on function public.mark_portal_inbox_source_read(text,text,uuid,text,text,timestamptz,jsonb) from public, anon, authenticated",
    );
    expect(sql).toContain(
      "grant execute on function public.mark_portal_inbox_source_read(text,text,uuid,text,text,timestamptz,jsonb) to service_role",
    );
  });
});
