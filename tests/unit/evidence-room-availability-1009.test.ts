/**
 * Evidence harness: an assistant answers "is this room free on these dates?"
 * from the REAL bookings, not from the listing's saved label.
 *
 * The fixture is one house whose rooms are each closed by a different real
 * source — an executed PropLane lease, a manually added resident, a manager's
 * room block, an imported Airbnb reservation, the manager's own unavailable
 * range, a future available-from date, and the second bed of a shared room.
 * Every answer below comes from `check_room_availability` calling the same
 * occupancy reader the Bookings calendar uses.
 *
 * With EVIDENCE_DIR set it writes `room-availability.txt`: the prospect's text,
 * the tool call, the tool's answer, and the fact that no guest, resident or
 * reservation code ever leaves the tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import type { AgentContext } from "@/lib/tools/context";

const grants = vi.hoisted(() => ({ read: new Set<string>() }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCalendarAccessForProperty: vi.fn(async (_db: unknown, _user: string, id: string) => grants.read.has(id)),
  managerCalendarReadableProperties: vi.fn(
    async (_db: unknown, _user: string, propertyIds: readonly string[]) =>
      new Set(propertyIds.filter((id) => grants.read.has(id))),
  ),
  managerCanWriteCalendarForProperty: vi.fn(async () => false),
}));
vi.mock("@/lib/occupancy/snapshot.server", () => ({ occupancySnapshotForManager: vi.fn() }));
vi.mock("@/lib/channel-calendar/bookings.server", () => ({ listManagerChannelCalendarBookings: vi.fn() }));

const fake = vi.hoisted(() => ({ db: null as unknown, catalog: [] as Array<Record<string, unknown> & { id: string }> }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => fake.db }));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: async () => fake.catalog }));
vi.mock("@/lib/rental-application/room-public-occupancy-eligibility", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/room-public-occupancy-eligibility")>()),
  executedApplicationIdsFromLeaseRecords: (rows: Array<{ row_data?: { executedApplicationId?: string } }>) =>
    new Set(
      rows.flatMap((r) =>
        r.row_data?.executedApplicationId ? [normalizeApplicationAxisId(r.row_data.executedApplicationId)] : [],
      ),
    ),
}));

import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import {
  checkRoomAvailabilityTool,
  __resetLeasingCatalogCache,
  __resetSmsOccupancyCache,
} from "@/lib/tools/domains/leasing-sms";

/** Nothing the rooms are closed BY may appear in an answer a prospect reads. */
const SECRETS = ["Alice Resident", "alice@example.com", "Bob Guest", "HMSECRET99", "Carol Manual", "Dana Block", "Airbnb"];

function buildListing() {
  const submission = createDefaultListingSubmission();
  const template = submission.rooms[0]!;
  const room = (id: string, extra: Record<string, unknown> = {}) => ({
    ...template,
    id,
    name: `Room ${id}`,
    monthlyRent: 900,
    occupancyCapacity: 1,
    moveInAvailableDate: "",
    ...extra,
  });
  submission.rooms = [
    room("lease"),
    room("manual"),
    room("block"),
    room("airbnb"),
    room("range", { manualUnavailableRanges: [{ id: "m1", start: "2027-03-01", end: "2027-03-10" }] }),
    room("future", { moveInAvailableDate: "2027-05-01" }),
    room("shared", { occupancyCapacity: 2 }),
    room("open"),
  ] as never;
  return submission;
}

function installDb(submission: ReturnType<typeof buildListing>) {
  const applications = [
    { id: "LEASE-1", manager_user_id: "manager-1", assigned: "home-1", choice: "home-1::lease", lease_start: "2026-11-01", lease_end: "2027-02-28", name: "Alice Resident", email: "alice@example.com" },
    { id: "MANUAL-1", manager_user_id: "manager-1", assigned: "home-1", choice: "home-1::manual", manually_added: "true", manual_start: "2026-10-01", manual_end: "2026-12-31", name: "Carol Manual" },
    { id: "SHARED-1", manager_user_id: "manager-1", assigned: "home-1", choice: "home-1::shared::r1", manually_added: "true", manual_start: "2026-11-01", manual_end: "2026-11-30" },
    { id: "SHARED-2", manager_user_id: "manager-1", assigned: "home-1", choice: "home-1::shared::r2", manually_added: "true", manual_start: "2026-11-15", manual_end: "2026-12-15" },
  ];
  const blocks = [
    {
      id: "blk-1",
      property_id: "home-1",
      row_data: { roomId: "block", checkIn: "2026-12-10", checkOut: "2026-12-15", residentName: "Dana Block", bookingStatus: "confirmed" },
    },
  ];
  const calendar = [
    {
      property_id: "home-1",
      room_id: "airbnb",
      imported_ranges: [
        { sourceUid: "u1", start: "2027-01-10", end: "2027-01-14", guestName: "Bob Guest", reservationCode: "HMSECRET99", provider: "airbnb" },
      ],
    },
  ];
  const leases = [{ manager_user_id: "manager-1", row_data: { executedApplicationId: "LEASE-1" } }];
  fake.db = {
    from(table: string) {
      // The single-row read is by id: an id this manager does not own answers null.
      let wantedId: unknown = null;
      return {
        select() { return this; },
        in() { return this; },
        eq(column: string, value: unknown) { if (column === "id") wantedId = value; return this; },
        or() { return this; },
        order() { return this; },
        limit() { return this; },
        maybeSingle: async () => ({
          data:
            wantedId === null || wantedId === "home-1"
              ? { id: "home-1", status: "live", property_data: fake.catalog[0], row_data: null }
              : null,
          error: null,
        }),
        range(start: number) {
          const rows =
            table === "portal_lease_pipeline_records" ? leases
            : table === "portal_schedule_records" ? blocks
            : table === "manager_application_records" ? applications
            : null;
          if (!rows) throw new Error(`Unexpected paged table: ${table}`);
          return Promise.resolve({ data: rows.slice(start), error: null });
        },
        then(resolve: (value: unknown) => unknown) {
          const data =
            table === "manager_property_records"
              ? [{ id: "home-1", manager_user_id: "manager-1", property_data: { listingSubmission: submission } }]
              : table === "external_calendar_connections"
                ? calendar
                : null;
          if (data === null) throw new Error(`Unexpected table: ${table}`);
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
    },
  };
}

const OUT = process.env.EVIDENCE_DIR ?? "";
const log: string[] = [];
function say(line = "") {
  log.push(line);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T18:00:00Z"));
  __resetLeasingCatalogCache();
  __resetSmsOccupancyCache();
  const submission = buildListing();
  installDb(submission);
  fake.catalog = [{ id: "home-1", title: "Cedar House", address: "1 Cedar St", listingSubmission: submission }];
  grants.read = new Set(["home-1"]);
});
afterEach(() => {
  vi.useRealTimers();
  if (!OUT || log.length === 0) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/room-availability.txt`, `${log.join("\n")}\n`);
});

type Verdict = {
  roomId: string;
  available: boolean | null;
  firstConflict?: { start: string; end: string | null };
  nextAvailableFrom?: string;
  rentLabel?: string;
};

describe("evidence · an assistant answers room availability from the real bookings", () => {
  it("every closed room is closed by a real booking, and the reason never leaks", async () => {
    const ctx = {
      landlordId: "manager-1",
      userId: "manager-1",
      roles: ["manager"],
      isAdmin: false,
      db: fake.db,
      listingPublicOnly: true,
    } as unknown as AgentContext;

    const asks: { text: string; roomId: string; expect: boolean; moveIn: string; moveOut?: string; closedBy: string }[] = [
      { text: "Hi! Is Room lease free Dec 1-5?", roomId: "lease", moveIn: "2026-12-01", moveOut: "2026-12-05", closedBy: "an executed PropLane lease (Nov 1 - Feb 28)", expect: false },
      { text: "What about Room lease in March?", roomId: "lease", moveIn: "2027-03-01", moveOut: "2027-03-10", closedBy: "nothing - the lease has ended", expect: true },
      { text: "Room manual, Dec 20 to Jan 5?", roomId: "manual", expect: false, moveIn: "2026-12-20", moveOut: "2027-01-05", closedBy: "a manually added resident (Oct 1 - Dec 31)" },
      { text: "Room block, Dec 12-14?", roomId: "block", expect: false, moveIn: "2026-12-12", moveOut: "2026-12-14", closedBy: "a manager's room block" },
      { text: "Room airbnb, Jan 12-16?", roomId: "airbnb", expect: false, moveIn: "2027-01-12", moveOut: "2027-01-16", closedBy: "an imported Airbnb reservation" },
      { text: "Room range, Mar 5-8?", roomId: "range", expect: false, moveIn: "2027-03-05", moveOut: "2027-03-08", closedBy: "the manager's own unavailable range" },
      { text: "Room future, Apr 1-10?", roomId: "future", expect: false, moveIn: "2027-04-01", moveOut: "2027-04-10", closedBy: "the room's available-from date (May 1)" },
      { text: "Room shared, Nov 5-10?", roomId: "shared", expect: true, moveIn: "2026-11-05", moveOut: "2026-11-10", closedBy: "nothing - one of two beds is free" },
      { text: "Room shared, Nov 20-25?", roomId: "shared", expect: false, moveIn: "2026-11-20", moveOut: "2026-11-25", closedBy: "both beds held" },
      { text: "Room open, any time next spring?", roomId: "open", expect: true, moveIn: "2027-04-01", moveOut: "2027-04-30", closedBy: "nothing" },
    ];

    say("Prospect texts the work number. Before quoting availability the assistant");
    say("MUST call check_room_availability; it reads the same occupancy the Bookings");
    say("calendar draws (leases, manual residents, room blocks, Airbnb stays, the");
    say("listing's own blocked dates, available-from, bed capacity) and answers in");
    say("dates only.");
    say();

    for (const ask of asks) {
      const out = (await checkRoomAvailabilityTool.handler(ctx, {
        listingId: "home-1",
        roomId: ask.roomId,
        moveIn: ask.moveIn,
        ...(ask.moveOut ? { moveOut: ask.moveOut } : {}),
      })) as { found: boolean; ok?: boolean; rooms?: Verdict[] };
      expect(out.found).toBe(true);
      expect(out.ok).toBe(true);
      const verdict = out.rooms![0]!;
      // The verdict is the real occupancy's, not the listing's saved label.
      expect(verdict.available, `${ask.roomId} ${ask.moveIn}`).toBe(ask.expect);
      // Whatever the room is closed by, the prospect never learns who or what.
      for (const secret of SECRETS) expect(JSON.stringify(out)).not.toContain(secret);

      say(`  prospect  "${ask.text}"`);
      say(`  tool      check_room_availability { listingId: home-1, roomId: ${ask.roomId}, moveIn: ${ask.moveIn}${ask.moveOut ? `, moveOut: ${ask.moveOut}` : ""} }`);
      say(
        `  answer    available=${verdict.available}` +
          (verdict.firstConflict ? `  firstConflict=${verdict.firstConflict.start}..${verdict.firstConflict.end ?? "open"}` : "") +
          (verdict.nextAvailableFrom ? `  nextAvailableFrom=${verdict.nextAvailableFrom}` : "") +
          (verdict.rentLabel ? `  rent=${verdict.rentLabel}` : ""),
      );
      say(`  closed by ${ask.closedBy}  (never said to the prospect)`);
      say();
    }

    say("No name, email, guest or reservation code appears anywhere above:");
    say(`  checked against ${SECRETS.length} secrets from the fixture - none present.`);
    say();
    say("Refusals (the tool fails closed rather than guessing):");
    const unknown = await checkRoomAvailabilityTool.handler(ctx, { listingId: "not-a-house", moveIn: "2027-01-12" });
    expect(unknown).toEqual({ found: false });
    say(`  unknown house        -> ${JSON.stringify(unknown)}`);
    const past = (await checkRoomAvailabilityTool.handler(ctx, { listingId: "home-1", moveIn: "2026-10-01" })) as {
      ok: boolean;
      error: string;
    };
    expect(past).toMatchObject({ ok: false, error: "invalid_dates" });
    say(`  move-in in the past  -> ${JSON.stringify(past)}`);
  });
});
