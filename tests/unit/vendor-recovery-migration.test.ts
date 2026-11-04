import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const sql = readFileSync("supabase/migrations/20261104160000_vendor_recovery_boundaries.sql", "utf8");
describe("vendor recovery migration boundary", () => {
  it("installs exact guards for owned roots and destructive children without widening archive scope", () => {
    for (const table of ["vendor_outreach_workspace_profiles", "vendor_quote_contact_capabilities", "vendor_quote_email_outbox", "vendor_quote_email_permissions", "vendor_quote_sms_consent_events", "vendor_quote_sms_consent_challenges", "vendor_sourcing_candidates", "vendor_sourcing_jobs", "vendor_coordination_phone_challenges", "vendor_coordination_phone_bindings", "vendor_coordination_reservations", "vendor_coordination_proposals", "vendor_quote_contact_sessions", "vendor_quote_email_delivery_events", "vendor_quote_responses", "vendor_coordination_operations"]) expect(sql).toContain(`'${table}'`);
    for (const excluded of ["sms_ingress_envelopes", "sms_platform_replies", "vendor_quote_sender_authority_revision"]) expect(sql).not.toContain(excluded);
    for (const check of ["existing_trigger.tgisinternal", "existing_trigger.tgfoid", "existing_trigger.tgtype<>31", "existing_trigger.tgtype<>9", "existing_trigger.tgattr::text<>''", "existing_trigger.tgenabled<>'O'", "existing_trigger.tgnargs<>0", "existing_trigger.tgqual is not null", "existing_trigger.tgconstraint<>0"]) expect(sql).toContain(check);
    expect(sql).not.toMatch(/drop trigger/i);
  });
  it("overrides enabled automation only for recovered service insertion", () => {
    expect(sql).toContain("current_setting('proplane.account_recovery_internal',true)='on' then 'dormant'");
    expect(sql).toContain("quoteSourcingEnabled'='true') then 'queued'");
    expect(sql).toContain("on conflict(work_order_id) do nothing");
  });
});
