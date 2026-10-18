/* eslint-disable @typescript-eslint/no-explicit-any -- loose recorders for mocked rows */
/**
 * The guest's two timed stay texts (bookings-times-1018): the arrival guide 24 h before the stay's
 * REAL check-in and the checkout reminder at 08:00 on checkout day. Real `materializeReminders`
 * against a recording fake, so the send instants asserted here are the ones the queue would store.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deliver = vi.fn<(...a: unknown[]) => Promise<{ ok: true; recipientCount: number; emailOutcomes: never[]; smsOutcomes: never[] }>>(async () => ({ ok: true, recipientCount: 1, emailOutcomes: [], smsOutcomes: [] }));
const notifyManager = vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined);
const resolveReminder = vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);

vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://prop-lane.space" }));
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalInboxMessage: (...args: unknown[]) => deliver(...args) }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: (...args: unknown[]) => notifyManager(...args) }));
vi.mock("@/lib/reminders/queue.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reminders/queue.server")>();
  return { ...actual, resolveReminder: (...args: unknown[]) => resolveReminder(...args) };
});

let quietHoursOn = false;
vi.mock("@/lib/reminders/settings.server", async () => {
  const rules = await import("@/lib/reminders/rules");
  return {
    loadReminderSettingsResolver: () =>
      Promise.resolve({
        resolve: () => ({ ...rules.DEFAULT_REMINDER_SETTINGS, quietHours: { ...rules.DEFAULT_QUIET_HOURS, enabled: quietHoursOn } }),
      }),
    loadReminderSettingsForManagers: () => Promise.resolve(new Map()),
  };
});

import { dispatchReminderRow } from "@/lib/reminders/dispatch.server";
import { reminderIsCurrent } from "@/lib/reminders/current.server";
import { DEFAULT_REMINDER_RULES, REMINDER_SUBJECT_KINDS } from "@/lib/reminders/rules";
import type { ReminderQueueRow } from "@/lib/reminders/queue.server";
import {
  guestStayFromRow,
  stayReminderSubjectId,
  sweepStayTimeReminders,
} from "@/lib/reminders/subjects/stay-times.server";
import { reminderSettingsGroup } from "@/lib/settings-message-groups";

const OWNER = "owner-1";
const GUEST = "guest-1";
const PACIFIC_HOUSE = "mgr-house-1";
const EASTERN_HOUSE = "mgr-house-ny";

const HOUSE_INFO = {
  access: { doorCode: "001000", gateCode: "#4821" },
  wifi: { network: "Brooklyn5259", password: "pa55-word" },
  rules: { smoking: "No smoking, vaping or cannabis anywhere" },
};

function propertyRecord(id: string, zip: string, stayTimes?: Record<string, unknown>) {
  return {
    id,
    row_data: { zip },
    property_data: { buildingName: id === PACIFIC_HOUSE ? "5259 Brooklyn" : "Chelsea House", listingSubmission: { zip, houseInfo: HOUSE_INFO, ...(stayTimes ? { stayTimes } : {}) } },
  };
}

function stayRecord(overrides: Record<string, unknown> = {}, rowData: Record<string, unknown> = {}) {
  return {
    id: "block-1",
    manager_user_id: OWNER,
    property_id: PACIFIC_HOUSE,
    record_type: "room_date_block",
    row_data: {
      propertyId: PACIFIC_HOUSE,
      roomId: "room-a",
      checkIn: "2026-10-16",
      checkOut: "2026-10-19",
      residentName: "Alex Guest",
      residentUserId: GUEST,
      bookingStatus: "confirmed",
      ...rowData,
    },
    ...overrides,
  };
}

type Upsert = { rows: Array<Record<string, any>> };

function fakeDb(input: { stays: unknown[]; properties?: unknown[]; queued?: Array<{ kind: string; subject_id: string }>; upserts?: Upsert[] }) {
  const properties = input.properties ?? [propertyRecord(PACIFIC_HOUSE, "98105"), propertyRecord(EASTERN_HOUSE, "10011")];
  const chain = (rows: unknown[]) => {
    const api: any = {
      eq: () => api,
      filter: () => api,
      not: () => api,
      gte: () => api,
      in: () => Promise.resolve({ data: rows, error: null }),
      limit: () => Promise.resolve({ data: rows, error: null }),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    };
    return api;
  };
  return {
    from(table: string) {
      if (table === "portal_schedule_records") return { select: () => chain(input.stays) };
      if (table === "manager_property_records") return { select: () => chain(properties) };
      if (table === "profiles") return { select: () => chain([{ id: GUEST, email: "Alex@Guest.test", full_name: "Alex Guest" }]) };
      if (table === "portal_reminder_records") {
        return {
          select: () => chain(input.queued ?? []),
          upsert: (rows: Array<Record<string, any>>) => {
            input.upserts?.push({ rows });
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as never;
}

async function sweep(stays: unknown[], now: string, extra: { properties?: unknown[]; queued?: Array<{ kind: string; subject_id: string }> } = {}) {
  const upserts: Upsert[] = [];
  const queued = await sweepStayTimeReminders(fakeDb({ stays, upserts, ...extra }), new Date(now));
  return { queued, rows: upserts.flatMap((u) => u.rows) };
}

beforeEach(() => {
  deliver.mockClear();
  notifyManager.mockClear();
  resolveReminder.mockClear();
  quietHoursOn = false;
});

describe("the two kinds are registered like every other reminder", () => {
  it("are guest-only by default, on the spine, and drawn under Bookings in What PropLane sends", () => {
    for (const kind of ["stay_arrival_guide", "stay_checkout_reminder"] as const) {
      expect(REMINDER_SUBJECT_KINDS).toContain(kind);
      const rule = DEFAULT_REMINDER_RULES[kind];
      expect(rule.enabled).toBe(true);
      expect(rule.audience).toEqual({ manager: false, counterparty: true, team: false, vendor: false });
      expect(reminderSettingsGroup(kind)).toBe("Bookings");
    }
    expect(reminderSettingsGroup("booking")).toBe("Bookings");
  });
});

describe("sweepStayTimeReminders: right instant, per time zone", () => {
  it("queues the arrival guide 24 h before a 3:00 pm Pacific check-in and the checkout reminder at 8:00 am Pacific", async () => {
    const { rows } = await sweep([stayRecord()], "2026-10-14T12:00:00Z");
    const guide = rows.find((row) => row.kind === "stay_arrival_guide")!;
    const checkout = rows.find((row) => row.kind === "stay_checkout_reminder")!;
    // 15:00 PDT Oct 15 and 08:00 PDT Oct 19 (UTC-7).
    expect(guide.send_at).toBe("2026-10-15T22:00:00.000Z");
    expect(checkout.send_at).toBe("2026-10-19T15:00:00.000Z");
    expect(guide.payload.anchorIso).toBe("2026-10-16T22:00:00.000Z");
    expect(checkout.payload.anchorIso).toBe("2026-10-19T18:00:00.000Z");
  });

  it("reads the check-in on the property's own clock: an Eastern house is 4 hours earlier in UTC", async () => {
    const { rows } = await sweep([stayRecord({ property_id: EASTERN_HOUSE }, { propertyId: EASTERN_HOUSE })], "2026-10-14T12:00:00Z");
    // 15:00 EDT Oct 15 = 19:00Z; 08:00 EDT Oct 19 = 12:00Z.
    expect(rows.find((row) => row.kind === "stay_arrival_guide")!.send_at).toBe("2026-10-15T19:00:00.000Z");
    expect(rows.find((row) => row.kind === "stay_checkout_reminder")!.send_at).toBe("2026-10-19T12:00:00.000Z");
  });

  it("follows a property's own default times and a stay's paid early check-in", async () => {
    const houseWith = [propertyRecord(PACIFIC_HOUSE, "98105", { checkInTime: "16:00", checkOutTime: "10:00" })];
    const standard = await sweep([stayRecord()], "2026-10-14T12:00:00Z", { properties: houseWith });
    expect(standard.rows.find((row) => row.kind === "stay_arrival_guide")!.send_at).toBe("2026-10-15T23:00:00.000Z");

    const early = await sweep(
      [stayRecord({}, { checkInTime: "12:00", stayDetails: { addOns: { early_check_in: { time: "12:00", priceCents: 2500, status: "paid" } } } })],
      "2026-10-14T12:00:00Z",
    );
    expect(early.rows.find((row) => row.kind === "stay_arrival_guide")!.send_at).toBe("2026-10-15T19:00:00.000Z");
  });

  it("anchors the checkout reminder on the paid late checkout and keeps it at 8:00 am", async () => {
    const { rows } = await sweep(
      [stayRecord({}, { stayDetails: { addOns: { late_check_out: { time: "14:00", priceCents: 2500, status: "paid" } } } })],
      "2026-10-14T12:00:00Z",
    );
    const checkout = rows.find((row) => row.kind === "stay_checkout_reminder")!;
    expect(checkout.send_at).toBe("2026-10-19T15:00:00.000Z");
    expect(checkout.payload.anchorIso).toBe("2026-10-19T21:00:00.000Z");
    expect(checkout.lead_minutes).toBe(360);
  });

  it("never queues for a hold, a cancelled stay, a stay with no login, a closed block, or a test row", async () => {
    const { queued, rows } = await sweep(
      [
        stayRecord({ id: "hold" }, { bookingStatus: "hold" }),
        stayRecord({ id: "cancelled", record_type: "cancelled_room_date_block" }, { bookingStatus: "cancelled" }),
        stayRecord({ id: "nologin" }, { residentUserId: "" }),
        stayRecord({ id: "closed" }, { residentUserId: undefined, bookingStatus: undefined, residentName: "" }),
        stayRecord({ id: "test" }, { smsTestSessionId: "sms-test-1", smsTestProvenance: { sessionId: "sms-test-1" } }),
      ],
      "2026-10-14T12:00:00Z",
    );
    expect(queued).toBe(0);
    expect(rows).toEqual([]);
  });

  it("goes to the guest alone: one counterparty recipient, no manager, no team, no door code in the stored payload", async () => {
    const { rows } = await sweep([stayRecord()], "2026-10-14T12:00:00Z");
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.recipient_role).toBe("counterparty");
      expect(row.recipient_email).toBe("alex@guest.test");
      expect(row.payload.recipientUserId).toBe(GUEST);
    }
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain("001000");
    expect(stored).not.toContain("pa55-word");
  });

  it("a re-sweep never double-sends: same dedupe keys; and a moved time is a different subject", async () => {
    const first = await sweep([stayRecord()], "2026-10-14T12:00:00Z");
    const again = await sweep([stayRecord()], "2026-10-14T12:05:00Z");
    expect(again.rows.map((row) => row.dedupe_key)).toEqual(first.rows.map((row) => row.dedupe_key));

    const moved = await sweep([stayRecord({}, { checkInTime: "12:00" })], "2026-10-14T12:00:00Z");
    const guideBefore = first.rows.find((row) => row.kind === "stay_arrival_guide")!;
    const guideAfter = moved.rows.find((row) => row.kind === "stay_arrival_guide")!;
    expect(guideAfter.subject_id).not.toBe(guideBefore.subject_id);
    expect(guideAfter.dedupe_key).not.toBe(guideBefore.dedupe_key);
  });

  it("holds an arrival guide that falls at 3 am until the quiet window ends, still before check-in", async () => {
    quietHoursOn = true;
    // Check-in 03:00 Oct 16 Pacific: the guide is due 03:00 Oct 15, inside 21:00-08:00 -> 08:00 Oct 15.
    const { rows } = await sweep([stayRecord({}, { checkInTime: "03:00" })], "2026-10-14T12:00:00Z");
    expect(rows.find((row) => row.kind === "stay_arrival_guide")!.send_at).toBe("2026-10-15T15:00:00.000Z");
  });

  it("a stay confirmed after the 24 h mark still gets one guide shortly before arrival, once", async () => {
    // 6 hours before the 15:00 PDT check-in.
    const now = "2026-10-16T16:00:00Z";
    const first = await sweep([stayRecord()], now);
    const guide = first.rows.filter((row) => row.kind === "stay_arrival_guide");
    expect(guide.length).toBe(1);
    expect(guide[0]!.send_at).toBe("2026-10-16T21:00:00.000Z");
    // The row now exists: the next tick adds nothing.
    const next = await sweep([stayRecord()], "2026-10-16T16:05:00Z", {
      queued: [{ kind: "stay_arrival_guide", subject_id: guide[0]!.subject_id }],
    });
    expect(next.rows.filter((row) => row.kind === "stay_arrival_guide")).toEqual([]);
  });
});

describe("currency: a cancelled stay or moved times never send the stale copy", () => {
  function queuedRow(kind: "stay_arrival_guide" | "stay_checkout_reminder", record: ReturnType<typeof stayRecord>): ReminderQueueRow {
    const stay = guestStayFromRow(record, { times: { checkInTime: "15:00", checkOutTime: "11:00" } as never, timeZone: "America/Los_Angeles" })!;
    return {
      id: "reminder-1",
      managerUserId: OWNER,
      kind,
      subjectId: stayReminderSubjectId(kind, stay),
      leadMinutes: 1440,
      recipientEmail: "alex@guest.test",
      recipientRole: "counterparty",
      sendAt: "2026-10-15T22:00:00.000Z",
      attempts: 0,
      payload: {
        stayBlockId: "block-1",
        recipientUserId: GUEST,
        anchorIso: kind === "stay_arrival_guide" ? "2026-10-16T22:00:00.000Z" : "2026-10-19T18:00:00.000Z",
      },
    };
  }

  const dbWith = (record: unknown) => fakeDb({ stays: record ? [record] : [] });

  it("is current while the stay is confirmed, the same guest, and the instant is unchanged", async () => {
    expect(await reminderIsCurrent(dbWith(stayRecord()), queuedRow("stay_arrival_guide", stayRecord()))).toBe(true);
    expect(await reminderIsCurrent(dbWith(stayRecord()), queuedRow("stay_checkout_reminder", stayRecord()))).toBe(true);
  });

  it("is stale when the stay was cancelled, went back to a hold, lost its guest, or was deleted", async () => {
    const row = queuedRow("stay_arrival_guide", stayRecord());
    expect(await reminderIsCurrent(dbWith(stayRecord({ record_type: "cancelled_room_date_block" }, { bookingStatus: "cancelled" })), row)).toBe(false);
    expect(await reminderIsCurrent(dbWith(stayRecord({}, { bookingStatus: "hold" })), row)).toBe(false);
    expect(await reminderIsCurrent(dbWith(stayRecord({}, { residentUserId: "someone-else" })), row)).toBe(false);
    expect(await reminderIsCurrent(dbWith(null), row)).toBe(false);
  });

  it("is stale when the check-in or checkout time moved after the row was queued", async () => {
    expect(await reminderIsCurrent(dbWith(stayRecord({}, { checkInTime: "12:00" })), queuedRow("stay_arrival_guide", stayRecord()))).toBe(false);
    expect(await reminderIsCurrent(dbWith(stayRecord({}, { checkOutTime: "14:00" })), queuedRow("stay_checkout_reminder", stayRecord()))).toBe(false);
  });

  it("is stale for anyone but the guest", async () => {
    const row = { ...queuedRow("stay_arrival_guide", stayRecord()), recipientRole: "manager" as const };
    expect(await reminderIsCurrent(dbWith(stayRecord()), row)).toBe(false);
  });
});

describe("delivery: the door code reaches only that guest's own 1:1 message", () => {
  const sender = { userId: OWNER, email: "owner@example.com", name: "Owner" };
  const channels = { inbox: true, email: true, sms: true };

  function guideRow(overrides: Partial<ReminderQueueRow> = {}): ReminderQueueRow {
    return {
      id: "reminder-1",
      managerUserId: OWNER,
      kind: "stay_arrival_guide",
      subjectId: "block:block-1:guide:2026-10-16T15:00",
      leadMinutes: 1440,
      recipientEmail: "alex@guest.test",
      recipientRole: "counterparty",
      sendAt: "2026-10-15T22:00:00.000Z",
      attempts: 0,
      payload: { stayBlockId: "block-1", recipientUserId: GUEST, recipientName: "Alex Guest", anchorIso: "2026-10-16T22:00:00.000Z" },
      ...overrides,
    };
  }

  it("sends the arrival guide to the guest's user id alone, with the code, the time and the Stays link", async () => {
    const db = fakeDb({ stays: [stayRecord()] });
    const result = await dispatchReminderRow(db, "worker-1", guideRow(), sender, channels);
    expect(result).toBe("sent");
    expect(deliver).toHaveBeenCalledTimes(1);
    const call = deliver.mock.calls[0]![1] as Record<string, any>;
    expect(call.toUserIds).toEqual([GUEST]);
    expect(call.toEmails).toBeUndefined();
    expect(call.broadcastCategories).toBeUndefined();
    expect(call.recipientsAuthorizedByCaller).toBe(true);
    expect(call.senderUserId).toBe(OWNER);
    expect(call.text).toContain("Door code: 001000");
    expect(call.text).toContain("Check-in is at 3:00 pm on Oct 16.");
    expect(call.text).toContain("Wi-Fi: Brooklyn5259, password pa55-word");
    expect(call.text).toContain("https://prop-lane.space/resident/stays");
    expect(call.smsText).toContain("Door code: 001000");
    expect(call.deliverViaSms).toBe(true);
    // Never routed through the manager/team notice path.
    expect(notifyManager).not.toHaveBeenCalled();
  });

  it("refuses a manager or team copy of the guide outright (the code is never addressed to anyone else)", async () => {
    const db = fakeDb({ stays: [stayRecord()] });
    for (const role of ["manager", "team", "vendor"] as const) {
      deliver.mockClear();
      const result = await dispatchReminderRow(db, "worker-1", guideRow({ recipientRole: role }), sender, channels);
      expect(result).toBe("failed");
      expect(deliver).not.toHaveBeenCalled();
      expect(notifyManager).not.toHaveBeenCalled();
    }
  });

  it("does not send once the stay is cancelled or its time moved", async () => {
    const cancelled = fakeDb({ stays: [stayRecord({ record_type: "cancelled_room_date_block" }, { bookingStatus: "cancelled" })] });
    expect(await dispatchReminderRow(cancelled, "worker-1", guideRow(), sender, channels)).toBe("failed");
    const moved = fakeDb({ stays: [stayRecord({}, { checkInTime: "12:00" })] });
    expect(await dispatchReminderRow(moved, "worker-1", guideRow(), sender, channels)).toBe("failed");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("the checkout reminder names the paid late time and carries no door code", async () => {
    const db = fakeDb({ stays: [stayRecord({}, { checkOutTime: "14:00" })] });
    const row = guideRow({
      kind: "stay_checkout_reminder",
      subjectId: "block:block-1:checkout:2026-10-19T14:00",
      leadMinutes: 360,
      payload: { stayBlockId: "block-1", recipientUserId: GUEST, recipientName: "Alex Guest", anchorIso: "2026-10-19T21:00:00.000Z" },
    });
    expect(await dispatchReminderRow(db, "worker-1", row, sender, channels)).toBe("sent");
    const call = deliver.mock.calls[0]![1] as Record<string, any>;
    expect(call.subject).toBe("Checkout is at 2:00 pm today");
    expect(call.text).toContain("Checkout is at 2:00 pm today at 5259 Brooklyn.");
    expect(call.text).not.toContain("001000");
    expect(call.toUserIds).toEqual([GUEST]);
  });
});
