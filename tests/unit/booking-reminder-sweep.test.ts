/**
 * Booking reminders actually fire.
 *
 * `rules.ts` used to exclude bookings on the reasoning that a booking rule
 * "could never fire". This is the proof that it now does: BOTH stay sources —
 * an imported Airbnb range and a PropLane lease's move-in — reach
 * `materializeReminders`, anchored on check-in and only while the rule is on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const materialize = vi.fn(() => Promise.resolve(1));

vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://prop-lane.space" }));
vi.mock("@/lib/reminders/queue.server", () => ({
  materializeReminders: (...args: unknown[]) => materialize(...(args as [])),
}));
vi.mock("@/lib/reminders/manager-recipients.server", () => ({
  loadManagerReminderRecipients: () =>
    Promise.resolve(new Map([["mgr-1", { email: "manager@example.com", name: "Morgan" }]])),
  loadTeamReminderRecipients: () => Promise.resolve([]),
  teamReminderRecipients: () => [],
}));

const rule = (enabled: boolean) => ({
  enabled,
  leadMinutes: [1440],
  audience: { manager: true, counterparty: false, team: false },
  teamUserIds: [],
  inbox: true,
  email: true,
  sms: false,
});

let bookingEnabled = true;
vi.mock("@/lib/reminders/settings.server", () => ({
  loadReminderSettingsForManagers: () =>
    Promise.resolve(
      new Map([["mgr-1", { rules: { booking: rule(bookingEnabled) }, quietHours: { enabled: false } }]]),
    ),
}));

import { sweepBookingReminders } from "@/lib/reminders/subjects/bookings.server";

const NOW = new Date("2026-09-10T12:00:00.000Z");

const CONNECTION = {
  id: "conn-1",
  manager_user_id: "mgr-1",
  property_id: "mgr-house-1",
  room_id: "room-b",
  label: "Airbnb · Room B",
  imported_ranges: [
    // Inside the 31-day horizon.
    { id: "r1", start: "2026-09-18", end: "2026-09-22", summary: "Airbnb (Not available)" },
    // Already past — reminding after check-in is not a reminder.
    { id: "r2", start: "2026-09-01", end: "2026-09-03", summary: "Airbnb (Not available)" },
    // Beyond the horizon, so the sweep stays bounded.
    { id: "r3", start: "2026-12-01", end: "2026-12-05", summary: "Airbnb (Not available)" },
  ],
};

const LEASE_ROW = {
  manager_user_id: "mgr-1",
  row_data: {
    id: "lease-9",
    residentName: "Cv Ponce",
    propertyId: "mgr-house-1",
    propertyName: "Ash Flats 6",
    application: { leaseStart: "2026-09-20", leaseEnd: "2027-09-20" },
  },
};

function fakeDb(connections: unknown[], leases: unknown[]) {
  return {
    from(table: string) {
      const rows = table === "external_calendar_connections" ? connections : leases;
      return {
        select: () => ({ limit: () => Promise.resolve({ data: rows, error: null }) }),
      };
    },
  } as never;
}

beforeEach(() => {
  materialize.mockClear();
  bookingEnabled = true;
});

describe("sweepBookingReminders", () => {
  it("queues an imported Airbnb stay and a PropLane move-in, anchored on check-in", async () => {
    await sweepBookingReminders(fakeDb([CONNECTION], [LEASE_ROW]), NOW);

    expect(materialize).toHaveBeenCalledTimes(2);
    const inputs = materialize.mock.calls.map((call) => call[1] as Record<string, unknown>);

    const channel = inputs.find((i) => String(i.subjectId).startsWith("channel:"))!;
    const stay = inputs.find((i) => String(i.subjectId).startsWith("stay:"))!;

    expect(channel.subjectId).toBe("channel:conn-1:r1");
    expect(channel.kind).toBe("booking");
    // 3pm Pacific on the 18th, not UTC midnight on the 18th.
    expect(channel.anchorIso).toBe("2026-09-18T22:00:00.000Z");

    expect(stay.subjectId).toBe("stay:lease-9");
    expect(stay.anchorIso).toBe("2026-09-20T22:00:00.000Z");
  });

  it("skips stays that are past or beyond the horizon", async () => {
    await sweepBookingReminders(fakeDb([CONNECTION], []), NOW);
    const ids = materialize.mock.calls.map((call) => (call[1] as { subjectId: string }).subjectId);
    expect(ids).toEqual(["channel:conn-1:r1"]);
  });

  it("sends only to the manager — an imported booking has no guest address", async () => {
    await sweepBookingReminders(fakeDb([CONNECTION], []), NOW);
    const input = materialize.mock.calls[0]![1] as { recipients: { role: string }[] };
    expect(input.recipients.map((r) => r.role)).toEqual(["manager"]);
  });

  it("queues nothing when the manager turned booking reminders off", async () => {
    bookingEnabled = false;
    const queued = await sweepBookingReminders(fakeDb([CONNECTION], [LEASE_ROW]), NOW);
    expect(materialize).not.toHaveBeenCalled();
    expect(queued).toBe(0);
  });
});
