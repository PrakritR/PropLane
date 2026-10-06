import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyManagerFromAgent = vi.fn();
const fulfillClaimedApplicationFeePayment = vi.fn();
const promoteClaimedApplicationAfterFee = vi.fn();
const getStripe = vi.fn();

vi.mock("@/lib/agent-notify.server", () => ({
  notifyManagerFromAgent: (...args: unknown[]) => notifyManagerFromAgent(...args),
}));

vi.mock("@/lib/application-fee-fulfillment.server", () => ({
  fulfillApplicationFeePayment: (...args: unknown[]) => fulfillClaimedApplicationFeePayment(...args),
  promoteClaimedApplicationAfterFee: (...args: unknown[]) => promoteClaimedApplicationAfterFee(...args),
}));

vi.mock("@/lib/stripe", () => ({
  getStripe: () => getStripe(),
}));

vi.mock("@/lib/app-url", () => ({
  resolveEmailLinkBaseUrl: () => "https://prop-lane.space",
}));

import {
  hasSubmittedApplicationForFee,
  reportOrphanedApplicationFeePayment,
} from "@/lib/report-orphaned-application-fee.server";

describe("hasSubmittedApplicationForFee", () => {
  it("returns true for a non-draft application on the same listing", async () => {
    const eq = vi.fn().mockReturnValue({
      order: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue({
          data: [
            {
              property_id: "prop-1",
              assigned_property_id: null,
              row_data: { bucket: "pending", stage: "Pending review", email: "a@b.com" },
            },
          ],
          error: null,
        }),
      }),
    });
    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ eq }),
      }),
    } as never;

    await expect(
      hasSubmittedApplicationForFee(db, { residentEmail: "a@b.com", propertyId: "prop-1" }),
    ).resolves.toBe(true);
  });

  it("returns false when only a draft exists", async () => {
    const eq = vi.fn().mockReturnValue({
      order: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue({
          data: [
            {
              property_id: "prop-1",
              assigned_property_id: null,
              row_data: { bucket: "pending", stage: "In progress", email: "a@b.com" },
            },
          ],
          error: null,
        }),
      }),
    });
    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ eq }),
      }),
    } as never;

    await expect(
      hasSubmittedApplicationForFee(db, { residentEmail: "a@b.com", propertyId: "prop-1" }),
    ).resolves.toBe(false);
  });
});

describe("reportOrphanedApplicationFeePayment", () => {
  const session = {
    id: "cs_orphan_1",
    payment_status: "paid",
    amount_total: 5000,
    customer_email: "applicant@example.com",
    metadata: {
      purpose: "rental_application_fee",
      application_id: "app_orphan_1",
      attempt_token: "attempt-1",
      property_id: "prop-1",
      resident_email: "applicant@example.com",
      manager_user_id: "mgr-1",
      resident_name: "Ada Applicant",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getStripe.mockReturnValue({
      checkout: {
        sessions: {
          retrieve: vi.fn().mockResolvedValue(session),
        },
      },
    });
    fulfillClaimedApplicationFeePayment.mockImplementation(async (_db, _stripe, paidSession) => ({
      chargeId: "hc_app_fee_1",
      ...(!paidSession.metadata?.application_id ? { legacy: true } : {}),
    }));
    promoteClaimedApplicationAfterFee.mockResolvedValue({ ok: true, promoted: false, reason: "no_draft" });
    notifyManagerFromAgent.mockResolvedValue({ delivered: true, suppressed: false });
  });

  function makeDb(opts?: { hasSubmitted?: boolean }) {
    const appLimit = vi.fn().mockResolvedValue({
      data: opts?.hasSubmitted
        ? [
            {
              property_id: "prop-1",
              assigned_property_id: null,
              row_data: { bucket: "pending", stage: "Pending review" },
            },
          ]
        : [],
      error: null,
    });
    const from = vi.fn((table: string) => {
      if (table === "manager_application_records") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({ limit: appLimit }),
            }),
          }),
        };
      }
      if (table === "portal_household_charge_records") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  manager_user_id: "mgr-1",
                  row_data: { amountLabel: "$50.00" },
                },
                error: null,
              }),
            }),
          }),
        };
      }
      return { select: vi.fn() };
    });
    return { from } as never;
  }

  it("ensures the paid charge and notifies the manager when no application exists", async () => {
    const db = makeDb({ hasSubmitted: false });
    const result = await reportOrphanedApplicationFeePayment(db, {
      sessionId: "cs_orphan_1",
      expectedEmail: "applicant@example.com",
    });

    expect(result).toEqual({
      ok: true,
      notified: true,
      chargeId: "hc_app_fee_1",
      reason: undefined,
    });
    expect(fulfillClaimedApplicationFeePayment).toHaveBeenCalled();
    expect(notifyManagerFromAgent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        landlordId: "mgr-1",
        category: "applications",
        idempotencyKey: "orphan_app_fee_cs_orphan_1",
      }),
    );
  });

  it("skips notify when the exact source application was already submitted", async () => {
    promoteClaimedApplicationAfterFee.mockResolvedValueOnce({ ok: true, promoted: false, reason: "already_submitted" });
    const db = makeDb({ hasSubmitted: true });
    const result = await reportOrphanedApplicationFeePayment(db, {
      sessionId: "cs_orphan_1",
      expectedEmail: "applicant@example.com",
    });

    expect(result).toEqual({
      ok: true,
      notified: false,
      chargeId: "hc_app_fee_1",
      reason: "application_exists",
    });
    expect(notifyManagerFromAgent).not.toHaveBeenCalled();
  });

  it("refuses when the email does not match the session", async () => {
    const db = makeDb();
    const result = await reportOrphanedApplicationFeePayment(db, {
      sessionId: "cs_orphan_1",
      expectedEmail: "other@example.com",
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(fulfillClaimedApplicationFeePayment).not.toHaveBeenCalled();
  });

  it("repairs only the bound financial source for an earlier paid session", async () => {
    getStripe.mockReturnValue({ checkout: { sessions: { retrieve: vi.fn().mockResolvedValue({
      ...session, metadata: { ...session.metadata, application_id: undefined, attempt_token: undefined },
    }) } } });
    const result = await reportOrphanedApplicationFeePayment(makeDb(), {
      sessionId: session.id, expectedEmail: "applicant@example.com",
    });
    expect(result).toMatchObject({ ok: true, notified: false, chargeId: "hc_app_fee_1", reason: "suppressed" });
    expect(fulfillClaimedApplicationFeePayment).toHaveBeenCalledOnce();
    expect(promoteClaimedApplicationAfterFee).not.toHaveBeenCalled();
    expect(notifyManagerFromAgent).not.toHaveBeenCalled();
  });
});
