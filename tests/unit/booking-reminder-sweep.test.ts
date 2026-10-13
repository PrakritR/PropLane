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
/** House `mgr-house-override` gets its own `booking` rule; every other house tracks the workspace's. */
let bookingOverrideRule: ReturnType<typeof rule> | null = null;
const OVERRIDE_PROPERTY_ID = "mgr-house-override";

vi.mock("@/lib/reminders/settings.server", () => ({
  loadReminderSettingsResolver: () =>
    Promise.resolve({
      resolve: (_managerUserId: string, propertyId: string | null) => ({
        rules: {
          booking:
            propertyId === OVERRIDE_PROPERTY_ID && bookingOverrideRule ? bookingOverrideRule : rule(bookingEnabled),
        },
        quietHours: { enabled: false },
      }),
    }),
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
    { id: "r1", start: "2026-09-18", end: "2026-09-22", summary: "Reserved" },
    // Already past — reminding after check-in is not a reminder.
    { id: "r2", start: "2026-09-01", end: "2026-09-03", summary: "Reserved" },
    // Beyond the horizon, so the sweep stays bounded.
    { id: "r3", start: "2026-12-01", end: "2026-12-05", summary: "Reserved" },
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

/** A hand-added booking (BUILD-WAVE2 C211) — same shape `bookings-block-dates-modal.tsx` and the sheet sync write. */
const ROOM_DATE_BLOCK_ROW = {
  id: "block-5",
  manager_user_id: "mgr-1",
  property_id: "mgr-house-2",
  row_data: {
    checkIn: "2026-09-19",
    checkOut: "2026-09-23", // exclusive
    reason: "Held",
    residentName: "Priya S.",
  },
};

/** A plain closed-dates block — nobody to check in, so it must never queue a reminder. */
const CLOSED_BLOCK_ROW = {
  id: "block-6",
  manager_user_id: "mgr-1",
  property_id: "mgr-house-2",
  row_data: { checkIn: "2026-09-19", checkOut: "2026-09-20", reason: "Maintenance" },
};

function fakeDb(connections: unknown[], leases: unknown[], blocks: unknown[] = []) {
  return {
    from(table: string) {
      const rows =
        table === "external_calendar_connections" ? connections : table === "portal_schedule_records" ? blocks : leases;
      return {
        select: () => ({
          limit: () => Promise.resolve({ data: rows, error: null }),
          eq: () => ({ limit: () => Promise.resolve({ data: rows, error: null }) }),
        }),
      };
    },
  } as never;
}

beforeEach(() => {
  materialize.mockClear();
  bookingEnabled = true;
  bookingOverrideRule = null;
});

describe("sweepBookingReminders", () => {
  it("queues an imported Airbnb stay and a PropLane move-in, anchored on check-in", async () => {
    await sweepBookingReminders(fakeDb([CONNECTION], [LEASE_ROW]), NOW);

    expect(materialize).toHaveBeenCalledTimes(3); // channel check-in + check-out, lease check-in
    const inputs = materialize.mock.calls.map((call) => call[1] as Record<string, unknown>);

    const channel = inputs.find((i) => String(i.subjectId).startsWith("channel:"))!;
    const stay = inputs.find((i) => String(i.subjectId).startsWith("stay:"))!;

    expect(channel.subjectId).toBe("channel:conn-1:r1");
    expect(channel.kind).toBe("booking");
    // 9am Pacific on the 18th, not UTC midnight on the 18th.
    expect(channel.anchorIso).toBe("2026-09-18T16:00:00.000Z");

    expect(stay.subjectId).toBe("stay:lease-9");
    expect(stay.anchorIso).toBe("2026-09-20T16:00:00.000Z");
  });

  it("queues the check-out reminder on its own subject, 9:00 PT on the day after the last night", async () => {
    await sweepBookingReminders(fakeDb([CONNECTION], []), NOW);
    const inputs = materialize.mock.calls.map((call) => call[1] as { subjectId: string; anchorIso: string; payload: { headline: string; url: string } });
    const out = inputs.find((i) => i.subjectId === "channel:conn-1:r1:out")!;
    // Last night Sep 22 -> check-out Sep 23, anchor 9:05 PT (16:05Z); the reminder fires 5 minutes earlier.
    expect(out.anchorIso).toBe("2026-09-23T16:05:00.000Z");
    expect(out.payload.headline).toMatch(/^Check-out today/);
    const settings = materialize.mock.calls.find((c) => (c[1] as { subjectId: string }).subjectId.endsWith(":out"))![2] as { rules: { booking: { timings: string[] } } };
    expect(settings.rules.booking.timings).toEqual(["before:5"]);
    const checkIn = inputs.find((i) => i.subjectId === "channel:conn-1:r1")!;
    expect(checkIn.payload.headline).toMatch(/^Check-in tomorrow/);
    expect(checkIn.payload.url).toContain("/portal/bookings/airbnb%3A");
  });

  it("never reminds for a host block", async () => {
    const block = { ...CONNECTION, imported_ranges: [{ id: "b", start: "2026-09-18", end: "2026-09-22", summary: "Airbnb (Not available)" }] };
    await sweepBookingReminders(fakeDb([block], []), NOW);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("skips stays that are past or beyond the horizon", async () => {
    await sweepBookingReminders(fakeDb([CONNECTION], []), NOW);
    const ids = materialize.mock.calls.map((call) => (call[1] as { subjectId: string }).subjectId);
    expect(ids).toEqual(["channel:conn-1:r1", "channel:conn-1:r1:out"]);
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

  it("BUILD-WAVE2 C211: a hand-added / sheet-imported booking (room_date_block) also queues, anchored on check-in", async () => {
    const queued = await sweepBookingReminders(fakeDb([], [], [ROOM_DATE_BLOCK_ROW]), NOW);
    expect(queued).toBe(2); // check-in + check-out
    const input = materialize.mock.calls[0]![1] as Record<string, unknown>;
    expect(input.subjectId).toBe("block:block-5");
    expect(input.anchorIso).toBe("2026-09-19T16:00:00.000Z");
    expect((input.payload as { title: string }).title).toContain("Priya S.");
  });

  it("BUILD-WAVE2 C211: a plain closed-dates block with no name or channel reason never queues", async () => {
    const queued = await sweepBookingReminders(fakeDb([], [], [CLOSED_BLOCK_ROW]), NOW);
    expect(queued).toBe(0);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("PLAN-0916-1040: a house override fires where the workspace value would not — and vice versa", async () => {
    // Workspace has bookings OFF; this one house turned them ON.
    bookingEnabled = false;
    bookingOverrideRule = rule(true);
    const overriddenConnection = { ...CONNECTION, id: "conn-override", property_id: OVERRIDE_PROPERTY_ID };
    const queued = await sweepBookingReminders(fakeDb([CONNECTION, overriddenConnection], []), NOW);
    // Only the overridden house's stay queued (check-in + check-out) — the workspace-scoped one did not.
    expect(queued).toBe(2);
    const ids = materialize.mock.calls.map((call) => (call[1] as { subjectId: string }).subjectId);
    expect(ids).toEqual(["channel:conn-override:r1", "channel:conn-override:r1:out"]);
  });
});
