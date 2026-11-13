import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseResidentIdentityStatus } from "@/lib/resident-identity/status";

const sql = readFileSync("supabase/migrations/20261030120000_resident_identity_verification.sql", "utf8");
const tables = ["subjects", "inquiries", "webhook_events", "manual_reviews"];

describe("resident identity storage boundary", () => {
  it("enables owner-scoped reads and reserves writes for the service role", () => {
    for (const table of tables) {
      expect(sql).toContain(`alter table public.resident_identity_${table} enable row level security`);
      expect(sql).toMatch(new RegExp(`on public\\.resident_identity_${table} for select to authenticated using \\(resident_user_id = auth\\.uid\\(\\)\\)`));
    }
    expect(sql).toMatch(/revoke all on [\s\S]* from public, anon, authenticated/);
    expect(sql).toMatch(/grant select on [\s\S]* to authenticated/);
    expect(sql).toMatch(/grant all on [\s\S]* to service_role/);
    expect(sql).not.toMatch(/for (insert|update|delete|all) to authenticated/i);
  });

  it("keeps a single active claim, binds event ownership, and deduplicates events", () => {
    expect(sql).toMatch(/unique index[\s\S]*resident_identity_one_active_inquiry_idx[\s\S]*where active/);
    expect(sql).toContain("provider_inquiry_id text unique");
    expect(sql).toContain("event_id text primary key");
    expect(sql).toContain("foreign key (inquiry_id, resident_user_id) references public.resident_identity_inquiries(id, resident_user_id)");
    expect(sql).toContain("last_event_created_at timestamptz");
  });

  it("does not turn an unknown status into approval", () => {
    expect(parseResidentIdentityStatus("approved")).toBe("approved");
    expect(parseResidentIdentityStatus("completed")).toBeNull();
    expect(parseResidentIdentityStatus(null)).toBeNull();
  });
});
