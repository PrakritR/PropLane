import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/payment-reminder-capability.server", () => ({ loadPaymentReminderChargeForActor: vi.fn() }));

import { loadPaymentReminderChargeForActor } from "@/lib/payment-reminder-capability.server";
import { loadPaymentReminderHistory } from "@/lib/payment-reminder-history.server";

function historyDb(occurrences: unknown[], deliveries: unknown[]) {
  const occurrenceQuery = {
    eq: vi.fn().mockReturnThis(),
    contains: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: occurrences, error: null }),
  };
  const deliveryQuery = {
    in: vi.fn().mockResolvedValue({ data: deliveries, error: null }),
  };
  const from = vi.fn((table: string) => {
    if (table === "payment_reminder_occurrences") return { select: () => occurrenceQuery };
    if (table === "payment_reminder_channel_deliveries") return { select: () => deliveryQuery };
    throw new Error(`Unexpected table ${table}`);
  });
  return { db: { from } as never, occurrenceQuery, deliveryQuery, from };
}

const occurrence = {
  id: "occ-1", manager_user_id: "owner-1", charge_ids: ["charge-1", "charge-2"],
  subject: "Combined reminder", created_at: "2026-09-13T10:00:00Z",
};

describe("payment reminder history scoping and status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("omits a bundled occurrence when a co-manager cannot read every covered charge", async () => {
    const { db, deliveryQuery } = historyDb([occurrence], []);
    vi.mocked(loadPaymentReminderChargeForActor).mockImplementation(async (_db, _actor, id) =>
      id === "charge-1" ? { charge: { id } as never, ownerUserId: "owner-1", propertyId: "home-1" } : null,
    );

    const result = await loadPaymentReminderHistory({
      db, actorUserId: "co-manager", ownerUserId: "owner-1", chargeId: "charge-1", admin: false,
    });

    expect(result).toEqual([]);
    expect(deliveryQuery.in).not.toHaveBeenCalled();
  });

  it("returns channel states without treating provider handoff as recipient delivery", async () => {
    const { db, occurrenceQuery } = historyDb([occurrence], [
      { occurrence_id: "occ-1", channel: "email", status: "submitted", attempts: 1,
        provider_reference: "email-provider-1", last_error: null, submitted_at: "2026-09-13T10:01:00Z",
        claim_expires_at: null, updated_at: "2026-09-13T10:01:00Z" },
      { occurrence_id: "occ-1", channel: "sms", status: "submitted", attempts: 1,
        provider_reference: null, last_error: null, submitted_at: "2026-09-13T10:01:00Z",
        claim_expires_at: null, updated_at: "2026-09-13T10:01:00Z" },
      { occurrence_id: "occ-1", channel: "inbox", status: "claimed", attempts: 2,
        provider_reference: null, last_error: "claim_expired_after_possible_submission", submitted_at: null,
        claim_expires_at: "2026-09-13T09:59:00Z", updated_at: "2026-09-13T09:55:00Z" },
    ]);
    const result = await loadPaymentReminderHistory({
      db, actorUserId: "owner-1", ownerUserId: "owner-1", chargeId: "charge-1", admin: false,
      now: new Date("2026-09-13T10:05:00Z"),
    });

    expect(occurrenceQuery.eq).toHaveBeenCalledWith("manager_user_id", "owner-1");
    expect(occurrenceQuery.contains).toHaveBeenCalledWith("charge_ids", ["charge-1"]);
    expect(result[0]?.coveredChargeIds).toEqual(["charge-1", "charge-2"]);
    expect(result[0]?.channels.map((channel) => channel.channel)).toEqual(["email", "sms", "inbox"]);
    expect(result[0]?.channels[0]).toMatchObject({ providerAcceptance: "confirmed", status: "submitted" });
    expect(result[0]?.channels[1]).toMatchObject({ providerAcceptance: "not_confirmed", status: "submitted" });
    expect(result[0]?.channels[2]).toMatchObject({ status: "claimed", effectiveStatus: "unknown", attempts: 2 });
    expect(loadPaymentReminderChargeForActor).not.toHaveBeenCalled();
  });
});
