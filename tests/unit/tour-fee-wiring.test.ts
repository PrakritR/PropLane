/**
 * The tour fee is wired into the three moments that matter: booking (a signed-in guest raises ONE fee charge before the
 * request is stored, an SMS prospect none), confirm (an unpaid fee refuses; no fee never gates) and a manager cancel
 * (a paid fee is refunded). The fee logic itself is covered in `tour-fee.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  raise: vi.fn(async (..._a: unknown[]) => null as null | { chargeId: string; amountCents: number; amountLabel: string }),
  settle: vi.fn(async (..._a: unknown[]) => ({ outcome: "no_fee" as const })),
  gate: vi.fn(async (..._a: unknown[]) => null as null | { status: 402 | 503; error: string }),
  planned: [] as Record<string, unknown>[],
  inquiries: [] as Record<string, unknown>[],
  upserts: [] as Record<string, unknown>[][],
  persistConfirm: vi.fn(async (..._a: unknown[]) => ({ ok: false as const, reason: "conflict" })),
}));

vi.mock("@/lib/tour-fee.server", () => ({
  raiseTourFeeCharge: h.raise,
  settleTourFeeOnCancel: h.settle,
  tourFeeConfirmGate: h.gate,
}));
vi.mock("@/lib/sms-consent", () => ({ recordOptIn: async () => undefined }));
vi.mock("@/lib/public-tour-booking-guard", () => ({
  adminHasPublishedSlot: async () => true,
  managerHasPublishedSlot: async () => true,
  managerMayHostPropertyTour: async () => true,
}));
vi.mock("@/lib/resident-identity/baseline.server", () => ({ resolveBaselineResidentIdentity: async () => "ok" }));
vi.mock("@/lib/tour-notification-delivery.server", () => ({
  notifyManagerTourRequest: async () => undefined,
  notifyTenantTourRequestReceived: async () => undefined,
  notifyTenantTourCanceled: async () => ({ ok: true }),
  notifyTenantTourConfirmed: async () => ({ ok: true }),
  notifyTenantTourRescheduled: async () => ({ ok: true }),
}));
vi.mock("@/lib/payment-automation-settings", () => ({ loadManagerAutomationSettings: async () => ({ proposeTourConfirmations: false }) }));
vi.mock("@/lib/tour-proposal.server", () => ({ proposeTourConfirmation: async () => undefined }));
vi.mock("@/lib/manager-default-tasks.server", () => ({ createApproveTourRequestTask: async () => undefined, createPrepareForTourTask: async () => undefined }));
vi.mock("@/lib/tour-schedule-persistence.server", () => ({ mutateConfirmedTourSchedule: h.persistConfirm }));
vi.mock("@/lib/tour-reminder.server", () => ({ cancelTourReminderForPlannedEvent: async () => undefined }));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncPlannedTourToGoogleCalendar: async () => null,
  deleteProplaneGoogleCalendarEvent: async () => undefined,
}));

import { createTourInquiry } from "@/lib/tour-inquiry-create.server";
import { confirmTourInquiry } from "@/lib/tour-inquiry-confirm.server";
import { cancelPlannedTour } from "@/lib/tour-planned-change.server";

const SLOT_KEY = "2099-09-07:18";
const START = "2099-09-07T16:00:00.000Z";
const END = "2099-09-07T16:30:00.000Z";

/** One fake db for all three: claims, the inquiry / planned singletons, and the schedule upserts. */
function fakeDb() {
  const from = (table: string) => {
    if (table === "tour_inquiry_claims") {
      return { insert: async () => ({ error: null }), delete: () => ({ eq: () => ({ then: (r: (v: { error: null }) => void) => r({ error: null }) }) }) };
    }
    let id = "";
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, value: string) => { if (col === "id") id = value; return q; },
      maybeSingle: async () => {
        if (id === "axis_admin_partner_inquiries_v1") return { data: { row_data: { payload: h.inquiries } }, error: null };
        if (id === "axis_admin_planned_events_v1") return { data: { row_data: { payload: h.planned } }, error: null };
        return { data: null, error: null };
      },
      then: (resolve: (v: { data: never[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
      upsert: async (records: Record<string, unknown>[]) => { h.upserts.push(records); return { error: null }; },
    };
    return q;
  };
  return { from } as never;
}

function tourRequest() {
  return {
    kind: "tour", name: "Gabi Guest", email: "gabi@example.com", phone: "2065550123", managerUserId: "mgr-1", propertyId: "prop-1", propertyTitle: "Lakeview",
    requestedWindows: [{ start: START, end: END, adminUserId: "mgr-1", slotKey: SLOT_KEY }], proposedStart: START, proposedEnd: END,
  };
}

beforeEach(() => {
  h.raise.mockReset().mockResolvedValue(null);
  h.settle.mockReset().mockResolvedValue({ outcome: "no_fee" });
  h.gate.mockReset().mockResolvedValue(null);
  h.persistConfirm.mockClear();
  h.upserts = [];
  h.planned = [];
  h.inquiries = [{ id: "inq-1", kind: "tour", status: "pending", managerUserId: "mgr-1", eligibleHostUserIds: ["mgr-1"], name: "Gabi Guest", propertyId: "prop-1", requestedWindows: [{ start: START, end: END, adminUserId: "mgr-1", slotKey: SLOT_KEY }] }];
});

describe("booking", () => {
  it("fee 0 (the default): the request is stored exactly as before, with no fee stamp", async () => {
    const result = await createTourInquiry(fakeDb(), { incoming: tourRequest(), verifiedApplicantEmail: "gabi@example.com", verifiedApplicantUserId: "user-1", notify: false });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.row).not.toHaveProperty("tourFee");
    expect(h.settle).not.toHaveBeenCalled();
  });

  it("fee above 0: a signed-in guest raises ONE fee charge for this inquiry and the stored request names it", async () => {
    h.raise.mockResolvedValue({ chargeId: "hc_tour_fee_x", amountCents: 2500, amountLabel: "$25.00" });
    const result = await createTourInquiry(fakeDb(), { incoming: tourRequest(), verifiedApplicantEmail: "gabi@example.com", verifiedApplicantUserId: "user-1", notify: false });
    expect(result.ok).toBe(true);
    expect(h.raise).toHaveBeenCalledTimes(1);
    const input = h.raise.mock.calls[0]![1] as { inquiryId: string; residentUserId: string };
    expect(input.residentUserId).toBe("user-1");
    if (result.ok) {
      expect(input.inquiryId).toBe(result.inquiryId);
      expect(result.row.tourFee).toEqual({ chargeId: "hc_tour_fee_x", amountCents: 2500, amountLabel: "$25.00" });
    }
    // Held: the pending request records are written (the existing slot hold).
    expect(h.upserts.length).toBeGreaterThan(0);
  });

  it("an SMS prospect (no account) is never charged", async () => {
    await createTourInquiry(fakeDb(), { incoming: tourRequest(), smsOrigin: { senderPhoneE164: "+12065550123" }, notify: false });
    expect(h.raise).not.toHaveBeenCalled();
  });

  it("a fee that cannot be raised refuses the request and stores nothing", async () => {
    h.raise.mockRejectedValue(new Error("boom"));
    const result = await createTourInquiry(fakeDb(), { incoming: tourRequest(), verifiedApplicantEmail: "gabi@example.com", verifiedApplicantUserId: "user-1", notify: false });
    expect(result).toMatchObject({ ok: false, reason: "write_failed" });
    expect(h.upserts).toHaveLength(0);
  });
});

describe("confirm", () => {
  const opts = { inquiryId: "inq-1", actorUserId: "mgr-1", notifyTenant: false };

  it("an unpaid fee refuses the confirm before anything is booked", async () => {
    h.inquiries = [{ ...h.inquiries[0]!, tourFee: { chargeId: "hc_tour_fee_inq-1", amountCents: 2500 } }];
    h.gate.mockResolvedValue({ status: 402, error: "The tour fee has not been paid yet." });
    const result = await confirmTourInquiry(fakeDb(), opts);
    expect(result).toMatchObject({ ok: false, status: 402 });
    expect(h.persistConfirm).not.toHaveBeenCalled();
  });

  it("a paid fee: the confirm goes on to book", async () => {
    h.inquiries = [{ ...h.inquiries[0]!, tourFee: { chargeId: "hc_tour_fee_inq-1", amountCents: 2500 } }];
    await confirmTourInquiry(fakeDb(), opts);
    expect(h.gate).toHaveBeenCalledWith(expect.anything(), "inq-1");
    expect(h.persistConfirm).toHaveBeenCalledTimes(1);
  });

  it("no fee was raised (the default): the fee is not even read, and the confirm books exactly as before", async () => {
    await confirmTourInquiry(fakeDb(), opts);
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.persistConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("a manager cancel", () => {
  const event = { id: "planned-1", kind: "tour", managerUserId: "mgr-1", start: START, end: END, slotKey: SLOT_KEY, attendeeEmail: "gabi@example.com", sourceInquiryId: "inq-1" };

  beforeEach(() => {
    h.persistConfirm.mockResolvedValue({ ok: true } as never);
  });

  it("settles the tour fee of the inquiry the tour came from", async () => {
    h.planned = [{ ...event }];
    const result = await cancelPlannedTour(fakeDb(), { plannedEventId: "planned-1", actorUserId: "mgr-1", notifyGuest: false });
    expect(result.ok).toBe(true);
    expect(h.settle).toHaveBeenCalledWith(expect.anything(), { inquiryId: "inq-1", reason: "manager_cancelled" });
  });

  it("a tour with no source inquiry (one the manager booked) has no fee to settle", async () => {
    const { sourceInquiryId: _omit, ...manual } = event;
    h.planned = [manual];
    await cancelPlannedTour(fakeDb(), { plannedEventId: "planned-1", actorUserId: "mgr-1", notifyGuest: false });
    expect(h.settle).not.toHaveBeenCalled();
  });
});
