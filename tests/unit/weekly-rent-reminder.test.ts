import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const { enqueueMock, dispatchMock, dedupeKeys } = vi.hoisted(() => ({
  dedupeKeys: new Set<string>(),
  enqueueMock: vi.fn(async (input: { dedupeKey: string }) => {
    const duplicate = dedupeKeys.has(input.dedupeKey);
    dedupeKeys.add(input.dedupeKey);
    return { ok: true as const, outboxId: input.dedupeKey, status: "queued", deduplicated: duplicate };
  }),
  dispatchMock: vi.fn(async () => ({ claimed: 1, submitted: 1, blocked: 0, unknown: 0 })),
}));

vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: enqueueMock,
  dispatchOwnerSmsOutbox: dispatchMock,
}));

import { isoWeekKey, sendWeeklyRentReminders, weeklyRentReminderDedupId } from "@/lib/sms/weekly-rent-reminder.server";

beforeEach(() => {
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG11111111111111111111111111111111");
});

function seed(opts?: { applicationConsent?: boolean; revoked?: boolean }) {
  const conversationKey = "mgrA:resident:resA";
  return createMemoryDb({
    portal_household_charge_records: [
      {
        manager_user_id: "mgrA",
        status: "pending",
        row_data: {
          id: "hc1",
          kind: "rent",
          residentEmail: "res@example.com",
          residentName: "Res One",
          residentUserId: "resA",
          managerUserId: "mgrA",
          propertyLabel: "12 Oak St #3",
          amountLabel: "$1,800",
          dueDateLabel: "Aug 1",
        },
      },
    ],
    profiles: [{ id: "resA", phone: "+12065552222", phone_verified_at: "2026-01-01T00:00:00Z", email: "res@example.com" }],
    manager_application_records: opts?.applicationConsent === false ? [] : [
      {
        id: "appA",
        manager_user_id: "mgrA",
        resident_email: "res@example.com",
        row_data: {
          id: "appA",
          email: "res@example.com",
          application: {
            phone: "+12065552222",
            smsConsent: true,
            smsConsentAt: "2026-01-01T00:00:00Z",
            smsConsentWordingVersion: "2026-07-28.1",
          },
        },
      },
    ],
    sms_consent_events: opts?.revoked ? [
      {
        recipient_phone_key: "2065552222",
        manager_user_id: "mgrA",
        messaging_service_sid: "MG11111111111111111111111111111111",
        purpose: "weekly_rent_reminder",
        send_class: "automated",
        conversation_key: conversationKey,
        event_type: "revoked",
        occurred_at: "2026-07-20T00:00:00Z",
        created_at: "2026-07-20T00:00:00Z",
      },
    ] : [],
    portal_outbound_mail_records: [],
  });
}

describe("isoWeekKey", () => {
  it("is stable within a Mon–Sun week and rolls over", () => {
    expect(isoWeekKey(new Date("2026-07-20T12:00:00Z"))).toBe(isoWeekKey(new Date("2026-07-24T12:00:00Z")));
    expect(isoWeekKey(new Date("2026-07-20T00:00:00Z"))).not.toBe(isoWeekKey(new Date("2026-07-27T00:00:00Z")));
  });
});

describe("sendWeeklyRentReminders — idempotent per week", () => {
  it("sends once, then a duplicate run (retry / redeploy / duplicate tick) does not text again", async () => {
    enqueueMock.mockClear();
    dispatchMock.mockClear();
    dedupeKeys.clear();
    const db = seed() as never;
    const now = new Date("2026-07-22T18:00:00Z");

    const first = await sendWeeklyRentReminders(db, { now });
    expect(first.sent).toBe(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    // Sent as automated so consent + quiet-hours gating applies downstream.
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ sendClass: "automated", recipientPhone: "+12065552222" }), expect.anything());

    const second = await sendWeeklyRentReminders(db, { now });
    expect(second.sent).toBe(0);
    expect(second.skippedAlreadySent).toBe(1);
    expect(dispatchMock).toHaveBeenCalledTimes(1); // second run only reads the durable dedupe row

    // A different week is a fresh reminder.
    const nextWeek = await sendWeeklyRentReminders(db, { now: new Date("2026-07-29T18:00:00Z") });
    expect(nextWeek.sent).toBe(1);
    expect(dispatchMock).toHaveBeenCalledTimes(2);
  });

  it("skips managers whose registration is not approved (null send number)", async () => {
    enqueueMock.mockReset();
    enqueueMock.mockResolvedValue({ ok: false, error: "number_not_active" });
    dispatchMock.mockClear();
    const db = seed() as never;
    const res = await sendWeeklyRentReminders(db, { now: new Date("2026-07-22T18:00:00Z") });
    expect(res.sent).toBe(0);
    expect(res.skippedNoSendNumber).toBe(1);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("does not enqueue an automated reminder without matching application consent", async () => {
    enqueueMock.mockClear();
    dispatchMock.mockClear();
    const db = seed({ applicationConsent: false });

    const res = await sendWeeklyRentReminders(db as never, { now: new Date("2026-07-22T18:00:00Z") });

    expect(res.sent).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.errors[0]?.error).toBe("scoped_consent_missing");
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("does not overwrite a later scoped revoke with historical application consent", async () => {
    enqueueMock.mockClear();
    dispatchMock.mockClear();
    const db = seed({ revoked: true });

    const res = await sendWeeklyRentReminders(db as never, { now: new Date("2026-07-22T18:00:00Z") });

    expect(res.sent).toBe(0);
    expect(res.errors[0]?.error).toBe("scoped_consent_missing");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("dedup id keys on week + manager + resident (one reminder per manager per resident per week)", () => {
    expect(weeklyRentReminderDedupId("2026-W30", "mgrA", "u_resA")).toBe("weekly_rent_sms_2026-W30_mgrA_u_resA");
    // Same resident under a different manager is a DISTINCT key.
    expect(weeklyRentReminderDedupId("2026-W30", "mgrB", "u_resA")).not.toBe(
      weeklyRentReminderDedupId("2026-W30", "mgrA", "u_resA"),
    );
  });
});
