import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  confirmProspectSmsTourOffer,
  mutateConfirmedTourSchedule,
} from "@/lib/tour-schedule-persistence.server";

type RpcResult = { data: unknown; error: { message: string } | null };

function dbFor(result: RpcResult | RpcResult[]) {
  const queue = Array.isArray(result) ? [...result] : [result];
  const rpc = vi.fn(async () => queue.shift() ?? { data: null, error: null });
  return { db: { rpc } as never, rpc };
}

const EVENT = {
  id: "planned-tour-1",
  kind: "tour",
  managerUserId: "11111111-1111-4111-8111-111111111111",
  propertyId: "property-1",
  slotKey: "2030-06-10:20",
  start: "2030-06-10T17:00:00.000Z",
  end: "2030-06-10T17:30:00.000Z",
};

describe("prospect tour scheduling persistence boundary", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("passes the trusted contact and exact offer to the service-only booking RPC", async () => {
    const { db, rpc } = dbFor({
      data: { ok: true, idempotent: false, plannedEventId: EVENT.id, status: "confirmed" },
      error: null,
    });

    await expect(confirmProspectSmsTourOffer(db, {
      managerUserId: EVENT.managerUserId,
      conversationKey: "manager:prospect:+12065550123",
      propertyId: EVENT.propertyId,
      trustedPhoneE164: "+12065550123",
      contactName: "Jordan Lee",
      contactEmail: "  jordan@example.test  ",
      offer: { slotKey: EVENT.slotKey, start: EVENT.start, end: EVENT.end, hostUserId: EVENT.managerUserId },
      event: EVENT,
      idempotencyKey: "prospect-tour:attempt-1",
    })).resolves.toEqual({ ok: true, idempotent: false, plannedEventId: EVENT.id, status: "confirmed" });

    expect(rpc).toHaveBeenCalledWith("confirm_prospect_sms_tour_offer", {
      p_manager_user_id: EVENT.managerUserId,
      p_conversation_key: "manager:prospect:+12065550123",
      p_property_id: EVENT.propertyId,
      p_trusted_phone_e164: "+12065550123",
      p_contact_name: "Jordan Lee",
      p_contact_email: "jordan@example.test",
      p_offer: { slotKey: EVENT.slotKey, start: EVENT.start, end: EVENT.end, hostUserId: EVENT.managerUserId },
      p_event: EVENT,
      p_idempotency_key: "prospect-tour:attempt-1",
    });
  });

  it("preserves optional-email semantics instead of inventing a contact address", async () => {
    const { db, rpc } = dbFor({
      data: { ok: true, idempotent: false, plannedEventId: EVENT.id, status: "confirmed" },
      error: null,
    });

    await expect(confirmProspectSmsTourOffer(db, {
      managerUserId: EVENT.managerUserId,
      conversationKey: "manager:prospect:+12065550123",
      propertyId: EVENT.propertyId,
      trustedPhoneE164: "+12065550123",
      contactName: "Jordan Lee",
      contactEmail: "   ",
      offer: { slotKey: EVENT.slotKey },
      event: EVENT,
      idempotencyKey: "prospect-tour:attempt-2",
    })).resolves.toMatchObject({ ok: true });

    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_contact_email: null });
  });

  it("returns idempotent success on a retried webhook without changing the event id", async () => {
    const { db, rpc } = dbFor({
      data: { ok: true, idempotent: true, plannedEventId: EVENT.id, status: "confirmed" },
      error: null,
    });

    await expect(confirmProspectSmsTourOffer(db, {
      managerUserId: EVENT.managerUserId,
      conversationKey: "manager:prospect:+12065550123",
      propertyId: EVENT.propertyId,
      trustedPhoneE164: "+12065550123",
      contactName: "Jordan Lee",
      offer: { slotKey: EVENT.slotKey },
      event: { ...EVENT, id: "retry-generated-id" },
      idempotencyKey: "prospect-tour:attempt-1",
    })).resolves.toEqual({ ok: true, idempotent: true, plannedEventId: EVENT.id, status: "confirmed" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("maps a competing reservation to a safe conflict without pretending it booked", async () => {
    const { db } = dbFor({ data: { ok: false, reason: "conflict" }, error: null });

    await expect(confirmProspectSmsTourOffer(db, {
      managerUserId: EVENT.managerUserId,
      conversationKey: "manager:prospect:+12065550124",
      propertyId: EVENT.propertyId,
      trustedPhoneE164: "+12065550124",
      contactName: "Taylor Morgan",
      offer: { slotKey: EVENT.slotKey },
      event: { ...EVENT, id: "planned-tour-2" },
      idempotencyKey: "prospect-tour:attempt-3",
    })).resolves.toEqual({ ok: false, reason: "conflict" });
  });

  it("uses one shared RPC boundary for append, replace, and cancel mutations", async () => {
    const { db, rpc } = dbFor([
      { data: { ok: true }, error: null },
      { data: { ok: true }, error: null },
      { data: { ok: true }, error: null },
    ]);
    await expect(mutateConfirmedTourSchedule(db, { operation: "append", event: EVENT })).resolves.toEqual({ ok: true });
    await expect(mutateConfirmedTourSchedule(db, {
      operation: "replace",
      event: { ...EVENT, start: "2030-06-10T18:00:00.000Z" },
      removeInquiryIds: ["inq-1"],
      expected: { start: EVENT.start, end: EVENT.end, generation: null },
    })).resolves.toEqual({ ok: true });
    await expect(mutateConfirmedTourSchedule(db, { operation: "cancel", event: EVENT })).resolves.toEqual({ ok: true });

    expect(rpc.mock.calls.map(([name, args]) => [name, args])).toEqual([
      ["mutate_confirmed_tour_schedule", { p_operation: "append", p_event: EVENT, p_remove_inquiry_ids: [], p_allow_conflict: false, p_expected_start: null, p_expected_end: null, p_expected_generation: null, p_expected_generation_known: false }],
      ["mutate_confirmed_tour_schedule", { p_operation: "replace", p_event: { ...EVENT, start: "2030-06-10T18:00:00.000Z" }, p_remove_inquiry_ids: ["inq-1"], p_allow_conflict: false, p_expected_start: EVENT.start, p_expected_end: EVENT.end, p_expected_generation: null, p_expected_generation_known: true }],
      ["mutate_confirmed_tour_schedule", { p_operation: "cancel", p_event: EVENT, p_remove_inquiry_ids: [], p_allow_conflict: false, p_expected_start: null, p_expected_end: null, p_expected_generation: null, p_expected_generation_known: false }],
    ]);
  });

  it("fails closed when the RPC is unavailable or returns an incomplete payload", async () => {
    const unavailable = dbFor({ data: null, error: { message: "database unavailable" } });
    await expect(confirmProspectSmsTourOffer(unavailable.db, {
      managerUserId: EVENT.managerUserId,
      conversationKey: "manager:prospect:+12065550123",
      propertyId: EVENT.propertyId,
      trustedPhoneE164: "+12065550123",
      contactName: "Jordan Lee",
      offer: { slotKey: EVENT.slotKey },
      event: EVENT,
      idempotencyKey: "prospect-tour:attempt-4",
    })).resolves.toEqual({ ok: false, reason: "database unavailable" });

    const malformed = dbFor({ data: { ok: true, status: "confirmed" }, error: null });
    await expect(confirmProspectSmsTourOffer(malformed.db, {
      managerUserId: EVENT.managerUserId,
      conversationKey: "manager:prospect:+12065550123",
      propertyId: EVENT.propertyId,
      trustedPhoneE164: "+12065550123",
      contactName: "Jordan Lee",
      offer: { slotKey: EVENT.slotKey },
      event: EVENT,
      idempotencyKey: "prospect-tour:attempt-5",
    })).resolves.toEqual({ ok: false, reason: "That tour time is no longer available." });
  });
});
