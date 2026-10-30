import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("preclaims the exact tour subject before binding only that pending handoff", () => {
  const sql = readFileSync("supabase/migrations/20261030144200_preclaim_tour_email_handoff.sql", "utf8");
  for (const fragment of ["p_placeholder is null", "p_digest is null", "consumed_user_id is null or consumed_user_id=p_user", "inquiry_id=p_inquiry", "expires_at>now()", "for update", "id=p_handoff and user_id=p_user", "token_digest=p_placeholder", "status='pending'", "exception when unique_violation then return false", "from public,anon,authenticated", "from public,anon,authenticated,service_role"]) expect(sql).toContain(fragment);
});
