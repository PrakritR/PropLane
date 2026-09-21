import { describe, expect, it, vi } from "vitest";

import {
  confirmProspectSmsTourOffer,
  prepareProspectSmsTourOffer,
} from "@/lib/tour-schedule-persistence.server";

const shared = {
  managerUserId: "manager-1",
  conversationKey: "manager-1:prospect:actor-1",
  propertyId: "property-1",
  contactName: "Alex",
  contactEmail: "alex@example.com",
  offer: { slotKey: "2026-09-20:20", start: "start", end: "end" },
  burstId: "burst-1",
  burstRevision: 4,
  workerId: "worker-1",
};

describe("authenticated SMS test tour persistence", () => {
  it("prepares through the actor-bound RPC without a routable phone", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ok: true, stateId: "state-1", stateRevision: 3 },
      error: null,
    });

    await expect(prepareProspectSmsTourOffer({ rpc } as never, {
      ...shared,
      testActorUserId: "actor-1",
    })).resolves.toEqual({ ok: true, stateId: "state-1", stateRevision: 3 });

    expect(rpc).toHaveBeenCalledWith(
      "prepare_authenticated_sms_test_tour_offer",
      expect.objectContaining({
        p_manager_user_id: "manager-1",
        p_test_actor_user_id: "actor-1",
        p_burst_id: "burst-1",
        p_burst_revision: 4,
        p_worker_id: "worker-1",
      }),
    );
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_trusted_phone_e164");
  });

  it("confirms through the actor-bound RPC with the same agreement and revision fences", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ok: true, idempotent: false, plannedEventId: "event-1", status: "confirmed" },
      error: null,
    });

    await expect(confirmProspectSmsTourOffer({ rpc } as never, {
      ...shared,
      testActorUserId: "actor-1",
      event: { id: "event-1", kind: "tour" },
      idempotencyKey: "prospect-tour:burst-1:4",
      agreementSourceMessageId: "source-2",
      claimedSourceIds: ["source-1", "source-2"],
    })).resolves.toMatchObject({ ok: true, plannedEventId: "event-1", idempotent: false });

    expect(rpc).toHaveBeenCalledWith(
      "confirm_authenticated_sms_test_tour_offer",
      expect.objectContaining({
        p_test_actor_user_id: "actor-1",
        p_burst_id: "burst-1",
        p_burst_revision: 4,
        p_agreement_source_message_id: "source-2",
        p_claimed_source_ids: ["source-1", "source-2"],
        p_worker_id: "worker-1",
        p_idempotency_key: "prospect-tour:burst-1:4",
      }),
    );
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_trusted_phone_e164");
  });

  it("leaves the live prospect path phone-bound", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { ok: true, stateId: "state-live", stateRevision: 1 }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, idempotent: true, plannedEventId: "event-live", status: "confirmed" }, error: null });

    await prepareProspectSmsTourOffer({ rpc } as never, {
      ...shared,
      trustedPhoneE164: "+12065550123",
    });
    await confirmProspectSmsTourOffer({ rpc } as never, {
      ...shared,
      trustedPhoneE164: "+12065550123",
      event: { id: "event-live", kind: "tour" },
      idempotencyKey: "live-key",
      agreementSourceMessageId: "source-live",
      claimedSourceIds: ["source-live"],
    });

    expect(rpc).toHaveBeenNthCalledWith(1, "prepare_prospect_sms_tour_offer", expect.objectContaining({
      p_trusted_phone_e164: "+12065550123",
    }));
    expect(rpc).toHaveBeenNthCalledWith(2, "confirm_prospect_sms_tour_offer", expect.objectContaining({
      p_trusted_phone_e164: "+12065550123",
    }));
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_test_actor_user_id");
    expect(rpc.mock.calls[1]?.[1]).not.toHaveProperty("p_test_actor_user_id");
  });
});
