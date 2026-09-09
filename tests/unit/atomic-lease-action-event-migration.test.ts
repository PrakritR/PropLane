import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/20260909100000_atomic_lease_action_events.sql"), "utf8");

describe("atomic lease action-event migration", () => {
  it("keeps the RPC service-only and couples updated_at CAS with pending intents", () => {
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = public, pg_temp/i);
    expect(sql).toMatch(/v_existing_updated_at is distinct from p_expected_updated_at/i);
    expect(sql).toMatch(/status, next_attempt_at, rendered[\s\S]*'pending', now\(\)/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*to service_role/i);
  });
});
