import { beforeEach, describe, expect, it, vi } from "vitest";

const consent = vi.hoisted(() => ({
  read: vi.fn(),
  record: vi.fn(),
  enqueue: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("@/lib/sms-consent", () => ({
  readScopedSmsConsentState: consent.read,
  recordScopedSmsConsent: consent.record,
}));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: consent.enqueue,
  dispatchOwnerSmsOutbox: consent.dispatch,
}));

import {
  PROSPECT_TOUR_REMINDER_BODY,
  dispatchProspectTourReminders,
  prospectTourReminderEligibility,
  registerProspectTourReminder,
} from "@/lib/sms/prospect-tour-reminder.server";

const availability = (recordedAt = "2026-09-15T20:00:00.000Z") => ({
  tool: "list_open_tour_slots",
  input: { propertyId: "listing-anonymized" },
  output: {
    publishedOnly: true,
    resolution: "resolved",
    slots: [{ slotKey: "2026-09-19:20", label: "Saturday, September 19, 2026 at 10:00 AM Pacific" }],
  },
  recordedAt,
});

describe("prospect tour reminder", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    consent.read.mockResolvedValue({ ok: true, state: "granted" });
    consent.record.mockResolvedValue({ ok: true });
    consent.dispatch.mockResolvedValue({ ok: true, claimed: 1, submitted: 1, blocked: 0, unknown: 0, infrastructureErrors: [] });
  });

  it("registers only a current published offer whose reply asks for an exact choice", () => {
    expect(prospectTourReminderEligibility(
      [availability()],
      "I have published openings Saturday. Which exact time works for you?",
    )).toEqual({ eligible: true, propertyId: "listing-anonymized" });

    expect(prospectTourReminderEligibility(
      [{ ...availability(), output: { publishedOnly: false, resolution: "resolved", slots: [{}] } }],
      "Which time works?",
    )).toEqual({ eligible: false });
    expect(prospectTourReminderEligibility(
      [availability(), { tool: "confirm_prospect_sms_tour", output: { ok: true }, recordedAt: "2026-09-15T20:00:00.000Z" }],
      "Your tour is booked.",
    )).toEqual({ eligible: false });
  });

  it("does not reuse an older turn's availability as a new reminder attempt", () => {
    expect(prospectTourReminderEligibility(
      [availability("2026-09-15T19:00:00.000Z"), {
        tool: "get_listing_details",
        input: { propertyId: "different-listing" },
        output: { found: true },
        recordedAt: "2026-09-15T20:00:00.000Z",
      }],
      "Which home did you mean?",
    )).toEqual({ eligible: false });
  });

  it("supports a fresh listing-grounded name question but not an unrelated listing question", () => {
    const details = {
      tool: "get_listing_details",
      input: { propertyId: "listing-anonymized" },
      output: { found: true, listing: { propertyId: "listing-anonymized" } },
      recordedAt: "2026-09-15T20:00:00.000Z",
    };
    expect(prospectTourReminderEligibility(
      [details],
      "What’s your name so I can finish scheduling the tour?",
    )).toEqual({ eligible: true, propertyId: "listing-anonymized" });
    expect(prospectTourReminderEligibility(
      [details],
      "Do you have any questions about the amenities?",
    )).toEqual({ eligible: false });
  });

  it("registers one durable attempt with the current burst and scoped conversation", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    await expect(registerProspectTourReminder({ rpc } as never, {
      burstId: "11111111-1111-4111-8111-111111111111",
      burstRevision: 4,
      managerUserId: "22222222-2222-4222-8222-222222222222",
      recipientPhoneE164: "+12065550123",
      candidateContext: [availability()],
      replyBody: "Which exact time works for you?",
      traceId: "trace-1",
    })).resolves.toEqual({ registered: true });
    expect(rpc).toHaveBeenCalledWith("register_prospect_sms_tour_reminder", {
      p_burst_id: "11111111-1111-4111-8111-111111111111",
      p_burst_revision: 4,
      p_manager_user_id: "22222222-2222-4222-8222-222222222222",
      p_conversation_key: "22222222-2222-4222-8222-222222222222:prospect:+12065550123",
      p_recipient_phone_e164: "+12065550123",
      p_property_id: "listing-anonymized",
      p_trace_id: "trace-1",
    });
  });

  it("fails closed on revoked consent before creating a durable attempt", async () => {
    consent.read.mockResolvedValue({ ok: true, state: "revoked" });
    const rpc = vi.fn();
    await expect(registerProspectTourReminder({ rpc } as never, {
      burstId: "11111111-1111-4111-8111-111111111111",
      burstRevision: 4,
      managerUserId: "22222222-2222-4222-8222-222222222222",
      recipientPhoneE164: "+12065550123",
      candidateContext: [availability()],
      replyBody: "Which exact time works for you?",
    })).resolves.toEqual({ registered: false, reason: "scoped_consent_revoked" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("claims once and hands the generic, freshness-safe reminder to the durable outbox", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{
        id: "reminder-1",
        burst_id: "burst-1",
        burst_revision: 7,
        manager_user_id: "22222222-2222-4222-8222-222222222222",
        conversation_key: "manager:prospect:+12065550123",
        recipient_phone_e164: "+12065550123",
        property_id: "listing-anonymized",
        trace_id: "trace-1",
      }], error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    consent.enqueue.mockResolvedValue({ ok: true, outboxId: "outbox-1", status: "deferred", deduplicated: false });

    await expect(dispatchProspectTourReminders({ rpc } as never, { workerId: "worker-1" }))
      .resolves.toEqual({ claimed: 1, enqueued: 1, cancelled: 0, retried: 0, failed: 0 });
    expect(consent.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      body: PROSPECT_TOUR_REMINDER_BODY,
      sendClass: "automated",
      purpose: "prospect_tour_followup",
      dedupeKey: "prospect-tour-reminder:burst-1:7",
      prospectTourReminderId: "reminder-1",
      recipientTimezone: "America/Los_Angeles",
    }), expect.anything());
    expect(rpc).toHaveBeenLastCalledWith("complete_prospect_sms_tour_reminder", expect.objectContaining({
      p_status: "enqueued",
      p_outbox_id: "outbox-1",
    }));
  });

  it("cancels an opted-out attempt and retries only infrastructure failures", async () => {
    const row = {
      id: "reminder-1", burst_id: "burst-1", burst_revision: 7,
      manager_user_id: "22222222-2222-4222-8222-222222222222",
      conversation_key: "manager:prospect:+12065550123",
      recipient_phone_e164: "+12065550123", property_id: null, trace_id: null,
    };
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [row, { ...row, id: "reminder-2", burst_id: "burst-2" }], error: null })
      .mockResolvedValue({ data: true, error: null });
    consent.enqueue
      .mockResolvedValueOnce({ ok: false, error: "recipient_opted_out" })
      .mockResolvedValueOnce({ ok: false, error: "control_plane_unreadable" });
    await expect(dispatchProspectTourReminders({ rpc } as never, { workerId: "worker-1" }))
      .resolves.toEqual({ claimed: 2, enqueued: 0, cancelled: 1, retried: 1, failed: 0 });
    expect(rpc).toHaveBeenCalledWith("complete_prospect_sms_tour_reminder", expect.objectContaining({ p_status: "cancelled" }));
    expect(rpc).toHaveBeenCalledWith("complete_prospect_sms_tour_reminder", expect.objectContaining({ p_status: "scheduled" }));
  });

  it("records a handoff failure for recovery when the worker loses its completion lease", async () => {
    const row = {
      id: "reminder-1", burst_id: "burst-1", burst_revision: 7,
      manager_user_id: "22222222-2222-4222-8222-222222222222",
      conversation_key: "manager:prospect:+12065550123",
      recipient_phone_e164: "+12065550123", property_id: null, trace_id: null,
    };
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [row], error: null })
      .mockResolvedValueOnce({ data: false, error: null });
    consent.enqueue.mockResolvedValue({ ok: true, outboxId: "outbox-1", status: "deferred", deduplicated: false });

    await expect(dispatchProspectTourReminders({ rpc } as never, { workerId: "crashed-worker" }))
      .resolves.toEqual({ claimed: 1, enqueued: 0, cancelled: 0, retried: 0, failed: 1 });
    expect(rpc).toHaveBeenLastCalledWith("complete_prospect_sms_tour_reminder", expect.objectContaining({
      p_status: "enqueued",
      p_outbox_id: "outbox-1",
    }));
  });
});
