import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260916130000_team_comms_action_events.sql"),
  "utf8",
);

describe("WS5/WS6 team-comms action-events migration", () => {
  it("widens the audience check to include team, defensively dropping both possible constraint names", () => {
    expect(sql).toMatch(/drop constraint if exists work_order_event_deliveries_audience_check/i);
    expect(sql).toMatch(/drop constraint if exists action_event_deliveries_audience_check/i);
    expect(sql).toMatch(/check \(audience in \('manager', 'resident', 'vendor', 'team'\)\)/i);
  });

  it("adds a durable draft_for_review flag, additive with a safe default", () => {
    expect(sql).toMatch(/add column if not exists draft_for_review boolean not null default false/i);
  });

  it("keeps the lease RPC service-only and CAS'd, and extends its audience whitelist to include team", () => {
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = public, pg_temp/i);
    expect(sql).toMatch(/v_existing_updated_at is distinct from p_expected_updated_at/i);
    expect(sql).toMatch(/v_delivery->>'audience' not in \('manager','resident','team'\)/i);
    expect(sql).toMatch(/v_delivery->>'audience' = 'team'/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*to service_role/i);
  });

  it("validates a team delivery's identity against the manager, same as the manager audience branch", () => {
    const teamBranch = sql.split("v_delivery->>'audience' = 'team'")[1] ?? "";
    expect(teamBranch).toMatch(/recipientUserId' is distinct from v_manager::text/i);
    expect(teamBranch).toMatch(/recipientKey' is distinct from v_manager::text/i);
  });
});
