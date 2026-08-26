import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/20260826140000_resident_sms_session_identity.sql"),
  "utf8",
).replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

describe("resident SMS session identity migration", () => {
  it("prevents duplicate history streams for one manager, resident and phone", () => {
    expect(SQL).toContain(
      "create unique index if not exists agent_sessions_resident_sms_identity_uidx on public.agent_sessions (landlord_id, user_id, vendor_phone_e164)",
    );
    expect(SQL).toContain("where kind = 'resident_sms' and user_id is not null and vendor_phone_e164 is not null");
  });
});
