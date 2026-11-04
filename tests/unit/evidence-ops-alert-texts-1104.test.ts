/**
 * Evidence harness — W30 admin ops alerts, as the "Also notify" phone actually receives them.
 *
 * Every line below is produced by the REAL path: the 7 AM digest run
 * (`runCheckinCheckoutDigest`) -> `alertPhonesOf` (subject, GSM-7 fold, per-kind cap,
 * idempotency key) -> `notifyWorkNumberRecipients` (one text per listed recipient, keyed per
 * recipient). Only the transport leg is mocked, so the body printed here is the body
 * `sendFromManagerWorkNumber` was handed.
 *
 * With EVIDENCE_DIR set it writes `ops-alert-texts.txt`.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

const sent: Array<{ to: string; text: string; dedupeKey?: string }> = [];
const emails: Array<{ to: string; subject: string; text: string }> = [];
const serviceAlerts: Array<{ subject: string; text: string }> = [];

vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendFromManagerWorkNumber: async (input: { to: string; text: string; dedupeKey?: string }) => {
    sent.push({ to: input.to, text: input.text, dedupeKey: input.dedupeKey });
    return { ok: true };
  },
}));
vi.mock("@/lib/manager-notice-email.server", () => ({
  sendManagerNoticeEmail: async (_db: unknown, input: { toEmail: string; subject: string; text: string }) => {
    emails.push({ to: input.toEmail, subject: input.subject, text: input.text });
    return { status: "sent" as const };
  },
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveWorkspaceSendLine: async () => ({ phoneNumber: "+12065550100" }),
}));
vi.mock("@/lib/one-number/link-destinations.server", () => ({
  resolveWorkspaceForProperty: async () => "ws-1",
}));
vi.mock("@/lib/service/service-manager-alerts.server", () => ({
  alertServiceManagerFromNotice: async (_db: unknown, input: { subject: string; text: string }) => {
    serviceAlerts.push({ subject: input.subject, text: input.text });
    return "sent";
  },
}));
vi.mock("@/lib/service/service-manager.server", () => ({
  readServiceManagerSettings: async () => null,
}));
vi.mock("@/lib/bookings/property-stay-times.server", () => ({
  propertyStayClockFromRecord: (row: { id?: unknown }) => ({
    times: row.id === "prop-5259" ? { checkInTime: "16:00", checkOutTime: "10:00" } : { checkInTime: "15:00", checkOutTime: "11:00" },
    timeZone: "America/Los_Angeles",
  }),
}));

const occupancy = vi.fn();
vi.mock("@/lib/occupancy/snapshot.server", () => ({ occupancyEntriesForManager: occupancy }));

const OWNER = "owner-service-1";
const TODAY = "2026-11-04";
/** 15:00 UTC on 2026-11-04 is 7 AM Pacific (PST). */
const SEVEN_AM_PACIFIC = () => new Date("2026-11-04T15:00:00Z");

/** The owner's listed "Also notify" people: a phone-only runner and a phone+email house manager. */
const RECIPIENTS = [
  { id: "rec-1", owner_user_id: OWNER, label: "Ops runner", phone: "+12065550199", email: null, created_at: "2026-10-01" },
  { id: "rec-2", owner_user_id: OWNER, label: "House manager", phone: "+12065550188", email: "ops@example.com", created_at: "2026-10-02" },
];

const TABLES: Record<string, unknown[]> = {
  workspace_work_number_recipients: RECIPIENTS,
  manager_property_records: [{ id: "prop-4709a" }, { id: "prop-5259" }],
  portal_workspaces: [],
};

function fakeDb() {
  const chain = (rows: unknown[]) => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.limit = () => Promise.resolve({ data: rows, error: null });
    q.order = () => Promise.resolve({ data: rows, error: null });
    return q;
  };
  return { from: (name: string) => chain(TABLES[name] ?? []) } as never;
}

/** A busy Wednesday at two houses: four arrivals and three departures across channels. */
const ENTRIES = [
  { source: "airbnb", propertyId: "prop-4709a", propertyLabel: "4709A", roomId: "r4", roomLabel: "Room 4", summary: "Anthony Rivera", start: TODAY, end: "2026-11-08" },
  { source: "proplane", propertyId: "prop-4709a", propertyLabel: "4709A", roomId: "r9", roomLabel: "Room 9", residentName: "Vaishnavi Sharma", start: TODAY, end: "2026-11-30" },
  { source: "airbnb", propertyId: "prop-4709a", propertyLabel: "4709A", roomId: "r7", roomLabel: "Room 7", summary: "Kumaran Selvam", start: "2026-10-30", end: "2026-11-03" },
  { source: "booking_com", propertyId: "prop-4709a", propertyLabel: "4709A", roomId: "r2", roomLabel: "Room 2", summary: "Booked (Booking.com)", start: "2026-10-28", end: "2026-11-03" },
  { source: "proplane", propertyId: "prop-5259", propertyLabel: "5259 Brooklyn", roomId: "r1", roomLabel: "Room 1", guestName: "Dana Okafor", start: TODAY, end: "2026-11-06" },
  { source: "hold", propertyId: "prop-5259", propertyLabel: "5259 Brooklyn", roomId: "r3", roomLabel: "Room 3", summary: "Held", start: TODAY, end: "2026-11-05", bookingStatus: "hold" },
];

const OUT = process.env.EVIDENCE_DIR ?? "";
const log: string[] = [];
const say = (line = "") => log.push(line);
afterAll(() => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/ops-alert-texts.txt`, `${log.join("\n")}\n`);
});

function printSent(header: string) {
  say(`--- ${header}`);
  for (const message of sent) say(`  SMS -> ${message.to}\n${message.text.split("\n").map((l) => `       | ${l}`).join("\n")}`);
  for (const message of emails) say(`  EMAIL -> ${message.to}  [${message.subject}]\n       | ${message.text}`);
  say();
}

beforeEach(() => {
  sent.length = 0;
  emails.length = 0;
  serviceAlerts.length = 0;
  occupancy.mockReset();
  occupancy.mockResolvedValue({ entries: ENTRIES });
});

describe("the 7 AM check-in / check-out digest, as the Also-notify phones get it", () => {
  it("texts one line per house, naming room, guest, channel and the house's own clock", async () => {
    const { runCheckinCheckoutDigest } = await import("@/lib/one-number/checkin-digest.server");
    const summary = await runCheckinCheckoutDigest(fakeDb(), { now: SEVEN_AM_PACIFIC });

    say("=========================================================================");
    say("W30 ops alerts — what the owner's \"Also notify\" phones receive");
    say("=========================================================================");
    say();
    say(`7 AM Pacific digest run: ${JSON.stringify(summary)}`);
    say();
    printSent("checkin_checkout_today (one text per house, both recipients)");

    expect(summary).toMatchObject({ owners: 1, houses: 2, sent: 2, failed: 0 });
    // Two houses x two recipients.
    expect(sent).toHaveLength(4);
    const bodies = sent.map((m) => m.text);
    expect(bodies[0]).toContain("PropLane: Check-ins and check-outs today");
    expect(bodies.join("\n")).toContain(
      "Today 4709A - check-in Room 4 (Anthony, Airbnb, 3 PM), Room 9 (Vaishnavi, 3 PM). Check-out Room 2 (Guest, Booking.com, 11 AM), Room 7 (Kumaran, Airbnb, 11 AM).",
    );
    // The house with its own clock prints its own times, and a held room is not a stay.
    expect(bodies.join("\n")).toContain("Today 5259 Brooklyn - check-in Room 1 (Dana, 4 PM).");
    expect(bodies.join("\n")).not.toContain("Room 3");
    // Every recipient's text is keyed on the house and the day, so a second cron run is a no-op.
    expect(new Set(sent.map((m) => m.dedupeKey)).size).toBe(4);
  });

  it("stays silent outside 7 AM Pacific", async () => {
    const { runCheckinCheckoutDigest } = await import("@/lib/one-number/checkin-digest.server");
    const out = await runCheckinCheckoutDigest(fakeDb(), { now: () => new Date("2026-11-04T16:00:00Z") });
    expect(out.skippedReason).toBe("not_7am");
    expect(sent).toHaveLength(0);
  });
});

describe("the other three alerts the admin asked for", () => {
  it("books, tours and application starts reach the same phones, one text each", async () => {
    const { alertPhonesOf } = await import("@/lib/one-number/ops-alerts.server");
    const { applicationStartedLine, bookingCreatedLine, nextDayKey, tourAlertLine } = await import("@/lib/one-number/ops-alert-lines");
    const db = fakeDb();

    // Exactly the calls the producers make (emitChannelBookingEvent / emitShortStayRequestedEvent /
    // notifyManagerTourRequest / emitTourManagerEvent / the application draft write).
    const cases: Array<[string, Parameters<typeof alertPhonesOf>[1]]> = [
      [
        "booking_created — an Airbnb reservation found by the calendar sync",
        {
          ownerUserId: OWNER, kind: "booking_created", entityId: "evt-1", propertyId: "prop-5259",
          idempotencyKey: "action-event:evt-1:manager",
          text: bookingCreatedLine({ house: "5259 Brooklyn", room: "Room 2", checkIn: "2026-11-06", checkOutExclusive: nextDayKey("2026-11-08"), source: "Airbnb" }),
        },
      ],
      [
        "booking_created — a guest's own stay request on PropLane (crosses a month)",
        {
          ownerUserId: OWNER, kind: "booking_created", entityId: "blk-9", propertyId: "prop-4709a",
          text: bookingCreatedLine({ house: "4709A", room: "Room 9", checkIn: "2026-11-29", checkOutExclusive: "2026-12-02", source: "PropLane", lead: "New stay request" }),
        },
      ],
      [
        "tour_requested — a prospect picked a time on the public tour page",
        {
          ownerUserId: OWNER, kind: "tour_requested", entityId: "tour-1", propertyId: "prop-4709a",
          text: tourAlertLine("requested", { guest: "Arjun Chandra", house: "4709A", whenIso: "2026-11-04T18:00:00Z" }),
        },
      ],
      [
        "tour_cancelled — the guest cancelled it",
        {
          ownerUserId: OWNER, kind: "tour_cancelled", entityId: "tour-1", propertyId: "prop-4709a",
          text: tourAlertLine("cancelled", { guest: "Arjun Chandra", house: "4709A" }),
        },
      ],
      [
        "application_started — the first draft write that carries a name",
        {
          ownerUserId: OWNER, kind: "application_started", entityId: "PROPLANE-AB12CD34", propertyId: "prop-4709a",
          text: applicationStartedLine({ applicant: "Vaishnavi Sharma", house: "4709A" }),
        },
      ],
    ];

    for (const [header, input] of cases) {
      sent.length = 0;
      emails.length = 0;
      const out = await alertPhonesOf(db, input);
      expect(out).toEqual({ texted: 2, emailed: 1 });
      printSent(header);
    }

    const all = log.join("\n");
    expect(all).toContain("New booking - 5259 Brooklyn Room 2, Nov 6-9 (Airbnb).");
    expect(all).toContain("New stay request - 4709A Room 9, Nov 29-Dec 2 (PropLane).");
    expect(all).toContain("Tour requested - Arjun C., 4709A, Wed Nov 4 10:00 AM.");
    expect(all).toContain("Tour cancelled - Arjun C., 4709A.");
    expect(all).toContain("Application started - Vaishnavi S., 4709A.");
  });

  it("a PropLane-managed workspace's Service phone hears only the two kinds the notice spine never carried", async () => {
    const { alertPhonesOf } = await import("@/lib/one-number/ops-alerts.server");
    const db = fakeDb();
    await alertPhonesOf(db, { ownerUserId: OWNER, kind: "booking_created", entityId: "b1", text: "New booking - 4709A, Nov 6." });
    expect(serviceAlerts).toHaveLength(0);
    await alertPhonesOf(db, { ownerUserId: OWNER, kind: "application_started", entityId: "a1", text: "Application started - Vaishnavi S., 4709A." });
    await alertPhonesOf(db, { ownerUserId: OWNER, kind: "checkin_checkout_today", entityId: "p1:2026-11-04", text: "Today 4709A - check-in Room 4 (Anthony, 3 PM)." });
    expect(serviceAlerts.map((a) => a.subject)).toEqual(["Application started", "Check-ins and check-outs today"]);
    say("--- PropLane Service phone (is_service workspaces only)");
    for (const alert of serviceAlerts) say(`  [${alert.subject}] ${alert.text}`);
    say();
  });
});
