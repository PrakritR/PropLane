import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const sql = readFileSync("supabase/migrations/20261030142000_email_onboarding_handoffs.sql", "utf8");
describe("email onboarding handoff schema", () => {
  it("keeps proof references and writes service-only", () => {
    expect(sql).toMatch(/token_digest text not null unique/i);
    expect(sql).toMatch(/user_id uuid not null references auth\.users/i);
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/revoke all on public\.email_onboarding_handoffs from public, anon, authenticated/i);
    expect(sql).toMatch(/grant all on public\.email_onboarding_handoffs to service_role/i);
  });
  it("expires claims and bounds service-only cleanup", () => {
    expect(sql).toMatch(/expires_at timestamptz not null/i);
    expect(sql).toMatch(/check \(expires_at > created_at\)/i);
    expect(sql).toMatch(/email_onboarding_handoffs_user_idx/i);
    expect(sql).toMatch(/where expires_at < now\(\) order by expires_at limit 100/i);
    expect(sql).toMatch(/grant execute on function public\.purge_expired_email_onboarding_handoffs\(\) to service_role/i);
  });
});
