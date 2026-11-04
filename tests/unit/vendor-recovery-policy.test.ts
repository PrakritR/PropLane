import { describe, expect, it } from "vitest";
import { vendorOwnRecordProjection } from "@/lib/vendor-own-record";
import { accountArchiveRules, ACCOUNT_RECOVERABLE_TABLES, ACCOUNT_RECOVERY_NEVER_RESTORE } from "@/lib/auth/account-recovery-policy";
const operational = ["vendor_outreach_workspace_profiles", "vendor_quote_contact_capabilities", "vendor_quote_email_outbox", "vendor_quote_email_permissions", "vendor_quote_sms_consent_events", "vendor_quote_sms_consent_challenges", "vendor_sourcing_candidates", "vendor_sourcing_jobs", "vendor_coordination_phone_challenges", "vendor_coordination_phone_bindings", "vendor_coordination_reservations", "vendor_coordination_proposals"];
const children = ["vendor_quote_contact_sessions", "vendor_quote_email_delivery_events", "vendor_quote_responses", "vendor_coordination_operations"];
describe("vendor recovery resets authority and preserves canonical records", () => {
  it.each([...operational, ...children])("never replays %s", table => {
    expect(ACCOUNT_RECOVERY_NEVER_RESTORE.has(table)).toBe(true);
    expect(ACCOUNT_RECOVERABLE_TABLES).not.toContain(table);
  });
  it("classifies manager operations without changing surviving business records", () => {
    const rules = accountArchiveRules("manager", true);
    for (const table of operational) expect(rules.find(rule => rule.table === table)?.recover).toBe(false);
    for (const table of ["manager_vendor_records", "portal_work_order_records", "work_order_bids", "portal_inbox_thread_records"]) {
      expect(ACCOUNT_RECOVERABLE_TABLES).toContain(table);
      expect(rules.find(rule => rule.table === table)?.recover).toBe(true);
    }
  });
  it("keeps private collision evidence out of the linked vendor profile", () => {
    const row = { id: "directory", name: "Vendor", trade: "Plumbing", phone: "+13175550002", email: "vendor@example.test", notes: "", active: true, vendorCoordinationAppointmentEvidence: { "service:consultation": { phoneE164: "+13175550009" } } };
    const projected = vendorOwnRecordProjection(row);
    expect(projected).not.toHaveProperty("vendorCoordinationAppointmentEvidence");
    expect(projected.name).toBe("Vendor");
  });
  it("does not restore a vendor phone binding or change manager ownership during vendor-only recovery", () => {
    const rules = accountArchiveRules("vendor", false);
    expect(rules.find(rule => rule.table === "vendor_coordination_phone_bindings")?.recover).toBe(false);
    expect(rules.find(rule => rule.table === "vendor_coordination_proposals")?.ids).toEqual([]);
    expect(rules.find(rule => rule.table === "vendor_coordination_proposals")?.detachIds).toContain("vendor_user_id");
  });
});
