// The durable prospect burst proves its receiving line through manager_sms_numbers; the shared PropLane number has
// no such row. The migration adds one narrow branch. A text guard on the branch's conditions (the function itself is
// SQL and was exercised against the dev database by the end-to-end harness).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20261019010000_burst_original_shared_line.sql", "utf8");

describe("burst original on the shared line (SQL)", () => {
  it("keeps the work-number proof first and adds the shared-line proof only when it found nothing", () => {
    const work = sql.indexOf("from public.manager_sms_numbers n");
    const shared = sql.indexOf("from public.sms_runtime_config c");
    expect(work).toBeGreaterThan(0);
    expect(shared).toBeGreaterThan(work);
    expect(sql.slice(work, shared)).toMatch(/if v_line_count <> 1 then/);
  });
  it("requires a live shared line, the configured number, a router-stamped workspace and the same owner", () => {
    for (const needle of ["c.line_mode = 'shared'", "c.shared_number_e164 = v_to", "w.owner_user_id = v_owner", "v_receipt.manager_user_id = v_owner", "inbound_payload->>'workspaceId'"]) {
      expect(sql).toContain(needle);
    }
  });
  it("is service-role only", () => {
    expect(sql).toMatch(/revoke all on function public\.resolve_sms_completed_receipt_original\(text,uuid\) from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function public\.resolve_sms_completed_receipt_original\(text,uuid\) to service_role;/);
  });
});
