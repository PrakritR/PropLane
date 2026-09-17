import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260916102500_prospect_tour_google_provider_write_fence.sql"),
  "utf8",
).toLowerCase();

describe("prospect tour Google provider-write fence migration", () => {
  it("registers every normal write and preserves an existing remote id", () => {
    expect(sql).toContain("begin_prospect_tour_google_calendar_write");
    expect(sql).toContain("nullif(trim(p_google_calendar_event_id), '')");
    expect(sql).toContain("provider_deadline_at = excluded.provider_deadline_at");
    expect(sql).toContain("state in ('creating', 'cleanup_required', 'reconcile_current', 'reconciling')");
  });

  it("extends the recovery lease through the bounded provider window", () => {
    expect(sql).toContain("begin_prospect_tour_google_calendar_reconciliation_write");
    expect(sql).toContain("provider_deadline_at = v_deadline");
    expect(sql).toContain("lease_expires_at = greatest");
    expect(sql).toContain("and state = 'reconciling'");
    expect(sql).toContain("and lease_owner = nullif(trim(p_worker_id), '')");
  });

  it("revalidates the exact generation and window after the provider version read", () => {
    expect(sql).toContain("validate_prospect_tour_google_calendar_write");
    expect(sql).toContain("i.generation = p_generation");
    expect(sql).toContain("i.expected_start is not distinct from p_expected_start");
    expect(sql).toContain("i.expected_end is not distinct from p_expected_end");
    expect(sql).toContain("i.lease_owner = nullif(trim(p_worker_id), '')");
  });

  it("keeps all write-fence RPCs service-only", () => {
    for (const fn of [
      "begin_prospect_tour_google_calendar_write",
      "begin_prospect_tour_google_calendar_reconciliation_write",
      "validate_prospect_tour_google_calendar_write",
    ]) {
      expect(sql).toContain(`revoke execute on function public.${fn}`);
      expect(sql).toContain(`grant execute on function public.${fn}`);
    }
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });
});
