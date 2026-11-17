import { describe, expect, it, vi } from "vitest";

const deliverPortalInboxMessage = vi.hoisted(() => vi.fn());
const loadResidentChargeActionBinding = vi.hoisted(() => vi.fn());
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalInboxMessage }));
vi.mock("@/lib/resident-charge-binding.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resident-charge-binding.server")>()),
  loadResidentChargeActionBinding,
}));

import {
  buildResidentChargeMessageBody,
  buildResidentChargeMessageSubject,
  sanitizeResidentChargeMessageBody,
} from "@/lib/resident-charge-message.server";
import type { HouseholdCharge } from "@/lib/household-charges";

const sampleCharge: HouseholdCharge = {
  id: "hc_test",
  createdAt: "2026-01-01T00:00:00.000Z",
  residentEmail: "resident@test.proplane.local",
  residentName: "Test Resident",
  residentUserId: "user-1",
  propertyId: "prop-1",
  propertyLabel: "Oak House",
  managerUserId: "mgr-1",
  kind: "rent",
  title: "March rent",
  amountLabel: "$1,200.00",
  balanceLabel: "$1,200.00",
  status: "pending",
  blocksLeaseUntilPaid: false,
};

describe("resident charge message helpers", () => {
  it("sanitizes and caps message bodies", () => {
    expect(sanitizeResidentChargeMessageBody("  hello\u0007world  ")).toBe("helloworld");
    expect(sanitizeResidentChargeMessageBody("x".repeat(2500)).length).toBe(2000);
  });

  it("builds manager-facing subject and body with charge context", () => {
    expect(buildResidentChargeMessageSubject(sampleCharge)).toBe("Question about March rent");
    expect(buildResidentChargeMessageBody(sampleCharge, "This looks wrong.")).toContain("March rent");
    expect(buildResidentChargeMessageBody(sampleCharge, "This looks wrong.")).toContain("This looks wrong.");
  });
});

describe("sendResidentChargeMessage", () => {
  it("rejects short messages", async () => {
    const { sendResidentChargeMessage } = await import("@/lib/resident-charge-message.server");
    const db = {} as never;
    const result = await sendResidentChargeMessage(db, {
      userId: "user-1",
      userEmail: "resident@test.proplane.local",
      residentName: "Test Resident",
      chargeId: "hc_test",
      message: "ok",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  /**
   * A phone sign-up resident signs in with a placeholder mailbox, so the charge their own application raised
   * carries neither their Auth id nor their address. They can see it and pay it; messaging their manager about
   * it follows the same one decision, and an address the binding reaches only by name still never does.
   */
  function chargeDb(charge: { applicationId?: string; residentUserId?: string | null }) {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      updates,
      from(table: string) {
        const query = {
          select: () => query,
          eq: () => query,
          update(values: Record<string, unknown>) {
            updates.push(values);
            return { eq: async () => ({ error: null }) };
          },
          maybeSingle: async () =>
            table === "portal_household_charge_records"
              ? {
                  data: {
                    id: "hc_test",
                    manager_user_id: "mgr-1",
                    resident_user_id: charge.residentUserId ?? null,
                    status: "pending",
                    row_data: {
                      ...sampleCharge,
                      residentUserId: charge.residentUserId ?? undefined,
                      ...(charge.applicationId ? { applicationId: charge.applicationId } : {}),
                    },
                  },
                  error: null,
                }
              : { data: null, error: null },
        };
        return query;
      },
    };
    return db;
  }

  it("lets a phone sign-up resident message about a charge their own application raised", async () => {
    deliverPortalInboxMessage.mockReset().mockResolvedValue({ ok: true });
    loadResidentChargeActionBinding.mockReset().mockResolvedValue({ applicationIds: ["PROPLANE-ABC"], managerEmails: [] });
    const { sendResidentChargeMessage } = await import("@/lib/resident-charge-message.server");
    const result = await sendResidentChargeMessage(chargeDb({ applicationId: "PROPLANE-ABC" }) as never, {
      userId: "phone-user",
      userEmail: "4b1c@phone.proplane.invalid",
      residentName: "Ava",
      chargeId: "hc_test",
      message: "Is this the deposit?",
    });
    expect(result.ok).toBe(true);
    expect(deliverPortalInboxMessage).toHaveBeenCalled();
  });

  it("still refuses a charge the binding reaches only by its address", async () => {
    deliverPortalInboxMessage.mockReset().mockResolvedValue({ ok: true });
    loadResidentChargeActionBinding.mockReset().mockResolvedValue({
      applicationIds: [],
      managerEmails: [{ managerUserId: "mgr-1", email: "resident@test.proplane.local" }],
    });
    const { sendResidentChargeMessage } = await import("@/lib/resident-charge-message.server");
    const result = await sendResidentChargeMessage(chargeDb({}) as never, {
      userId: "phone-user",
      userEmail: "4b1c@phone.proplane.invalid",
      residentName: "Ava",
      chargeId: "hc_test",
      message: "Is this the deposit?",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
    expect(deliverPortalInboxMessage).not.toHaveBeenCalled();
  });
});
