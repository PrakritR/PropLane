/**
 * One map from a send refusal to the one word the work-number card may print.
 * Both branches of `/api/manager/messaging-number` word a blocked line through
 * it, so an owner and a teammate read the same state identically.
 * docs/agents/sms-system.md § One work number per workspace.
 */
import { describe, expect, it } from "vitest";
import { lineBlockForSendReadinessReason } from "@/lib/sms/workspace-send-readiness.server";
import { WORKSPACE_NO_WORK_NUMBER_CODE } from "@/lib/sms/workspace-no-work-number";

describe("lineBlockForSendReadinessReason", () => {
  it("calls the deployment's own switch and seat a deployment block", () => {
    expect(lineBlockForSendReadinessReason("runtime_paused")).toBe("deployment");
    expect(lineBlockForSendReadinessReason("manager_not_allowlisted")).toBe("deployment");
  });

  it("calls every wallet refusal a billing block", () => {
    for (const reason of ["allowance_exhausted", "billing_paused", "trial", "plan_unreadable", "no_payment_method", "free_tier"]) {
      expect(lineBlockForSendReadinessReason(`comms_billing_${reason}`)).toBe("billing");
    }
  });

  it("calls a provisioned, registered line held on the provider side paused, never unfinished setup", () => {
    // Quarantine leaves `provision_state: "active"`, so the number IS shown and
    // the caption branch renders: "Finishing setup" over it would send the
    // manager hunting for a setup step that is already done.
    for (const reason of [
      "number_quarantined",
      "number_in_grace",
      "number_grace_expired",
      "number_grace_invalid",
      "provider_identity_mismatch",
    ]) {
      expect(lineBlockForSendReadinessReason(reason)).toBe("paused");
    }
  });

  it("reserves setup for a line that genuinely is not provisioned or registered yet", () => {
    for (const reason of [
      "number_missing",
      "number_not_active",
      "manager_registration_not_approved",
      "number_not_attached",
      "number_not_registered",
      WORKSPACE_NO_WORK_NUMBER_CODE,
    ]) {
      expect(lineBlockForSendReadinessReason(reason)).toBe("setup");
    }
  });

  it("claims no reason it does not have", () => {
    expect(lineBlockForSendReadinessReason("control_plane_unreadable")).toBe("unavailable");
    expect(lineBlockForSendReadinessReason(null)).toBe("unavailable");
    expect(lineBlockForSendReadinessReason(undefined)).toBe("unavailable");
    expect(lineBlockForSendReadinessReason("   ")).toBe("unavailable");
  });
});
