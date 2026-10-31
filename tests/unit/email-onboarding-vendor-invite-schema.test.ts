import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const sql = readFileSync("supabase/migrations/20261030143000_email_onboarding_vendor_invites.sql", "utf8");
describe("vendor invite handoff schema", () => {
  it("stores only the invite reference and extends the service-only handoff intent", () => {
    expect(sql).toMatch(/vendor_invite_id uuid references public\.vendor_invites\(id\) on delete cascade/i);
    expect(sql).toMatch(/'vendor_invite'/);
    expect(sql).not.toMatch(/invite_token\s+text/i);
  });
});
