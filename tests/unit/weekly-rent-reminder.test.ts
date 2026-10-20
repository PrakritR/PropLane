import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const { sendMock, mintMock } = vi.hoisted(() => ({
  // The outbox row the real sender leaves behind is what the week's dedupe reads.
  sendMock: vi.fn(async (db: { from: (t: string) => { insert: (r: unknown) => unknown } }, input: { idempotencyKey: string }) => {
    await db.from("sms_outbox").insert({ manager_user_id: "mgrA", dedupe_key: input.idempotencyKey, status: "submitted" });
    return { ok: true as const, outboxId: input.idempotencyKey };
  }),
  mintMock: vi.fn(async () => ({ kind: "phone_bound" as const, url: "https://proplane.ai/l/Zk3T9v1q8mY2nB7cX4wR6pD0sL5hJ1aF3gU9eO8iKt" })),
}));

vi.mock("@/lib/payments/rent-text-send.server", () => ({ sendResidentRentText: sendMock }));
vi.mock("@/lib/payments/rent-reminder-links.server", () => ({ mintRentReminderPayLink: mintMock }));

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
    sendMock.mockClear();
    mintMock.mockClear();
    const db = seed() as never;
    const now = new Date("2026-07-22T18:00:00Z");

    const first = await sendWeeklyRentReminders(db, { now });
    expect(first.sent).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    // Sent as automated so consent + quiet-hours gating applies downstream, from the house's workspace line,
    // with a fresh phone-bound pay link on its own line.
    const sent = sendMock.mock.calls[0]![1] as { sendClass: string; phone: string; purpose: string; body: string; ownerUserId: string };
    expect(sent).toMatchObject({ sendClass: "automated", phone: "+12065552222", purpose: "weekly_rent_reminder", ownerUserId: "mgrA" });
    expect(sent.body.split("\n").slice(-2)).toEqual(["Pay here:", "https://proplane.ai/l/Zk3T9v1q8mY2nB7cX4wR6pD0sL5hJ1aF3gU9eO8iKt"]);
    expect(mintMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ phone: "+12065552222", phoneVerifiedAt: "2026-01-01T00:00:00Z" }));

    const second = await sendWeeklyRentReminders(db, { now });
    expect(second.sent).toBe(0);
    expect(second.skippedAlreadySent).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1); // second run only reads the durable dedupe row

    // A different week is a fresh reminder.
    const nextWeek = await sendWeeklyRentReminders(db, { now: new Date("2026-07-29T18:00:00Z") });
    expect(nextWeek.sent).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("a quiet-hours hold is deferred, not a failure", async () => {
    sendMock.mockClear();
    sendMock.mockResolvedValueOnce({ ok: false as never, error: "quiet_hours" } as never);
    const res = await sendWeeklyRentReminders(seed() as never, { now: new Date("2026-07-22T06:00:00Z") });
    expect(res).toMatchObject({ sent: 0, deferred: 1, failed: 0 });
  });

  it("skips managers whose registration is not approved (null send number)", async () => {
    sendMock.mockClear();
    sendMock.mockResolvedValueOnce({ ok: false as never, error: "number_not_active" } as never);
    const db = seed() as never;
    const res = await sendWeeklyRentReminders(db, { now: new Date("2026-07-22T18:00:00Z") });
    expect(res.sent).toBe(0);
    expect(res.skippedNoSendNumber).toBe(1);
  });

  it("does not enqueue an automated reminder without matching application consent", async () => {
    sendMock.mockClear();
    const db = seed({ applicationConsent: false });

    const res = await sendWeeklyRentReminders(db as never, { now: new Date("2026-07-22T18:00:00Z") });

    expect(res.sent).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.errors[0]?.error).toBe("scoped_consent_missing");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not overwrite a later scoped revoke with historical application consent", async () => {
    sendMock.mockClear();
    const db = seed({ revoked: true });

    const res = await sendWeeklyRentReminders(db as never, { now: new Date("2026-07-22T18:00:00Z") });

    expect(res.sent).toBe(0);
    expect(res.errors[0]?.error).toBe("scoped_consent_missing");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("dedup id keys on week + manager + resident (one reminder per manager per resident per week)", () => {
    expect(weeklyRentReminderDedupId("2026-W30", "mgrA", "u_resA")).toBe("weekly_rent_sms_2026-W30_mgrA_u_resA");
    // Same resident under a different manager is a DISTINCT key.
    expect(weeklyRentReminderDedupId("2026-W30", "mgrB", "u_resA")).not.toBe(
      weeklyRentReminderDedupId("2026-W30", "mgrA", "u_resA"),
    );
  });
});
