// @vitest-environment jsdom
/**
 * Evidence harness for the 2026-10-11 ship: ONE occupancy rule everywhere, and an SMS
 * conversation named by its person in exactly one inbox row.
 *
 * Part 1 — one rule. A single fixture house is held by one of every real occupant:
 *   a signed-lease resident, an approved applicant still waiting on a signature, a
 *   hand-added resident, an Airbnb reservation, a manager's room block and the listing's
 *   own blocked dates — plus a shared room where PropLane's own "Not available" export
 *   echoes back on top of its resident, which must NOT take a second bed. The same four
 *   surfaces a user actually looks at are then driven off that one fixture:
 *     A  the manager dashboard property card + Occupancy KPI  (real occupancySnapshotForManager)
 *     B  the property room rows                               (real panel over /api/portal/occupancy)
 *     C  the public listing Rooms table and the apply wizard  (real loadPublicRoomOccupancy)
 *     D  the leasing bots                                     (real check_room_availability / get_listing_details)
 *   Every surface has to name the same occupied rooms. Nothing is restated as a fixture:
 *   B is fed the real snapshot through the real route shape, C and D read the real public
 *   loader over the same database.
 *
 * Part 2 — SMS naming and one row. An unknown texter writes "Hi I'm looking for a room";
 *   the row is titled by the phone number, never "looking for". A later "My name is Maya
 *   Chen" names it. The server's own auto-reply never becomes the row's title, and the
 *   stored notice copy folds into the projected conversation so Communication lists ONE
 *   row. The repair script's verdict is run over the names the old guess left behind.
 *
 * With EVIDENCE_DIR set it writes the rendered surfaces (`*.html`, screenshotted by
 * `tests/browser/promote-production-1009/shots.spec.ts`) and two transcripts.
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-room-truth-and-sms-1011.test.tsx
 *   EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/promote-production-1009.config.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/properties/all/cedar-1",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-prospect-contact-autofill", () => ({
  useProspectContactAutofill: () => ({ contact: null, loading: false }),
}));

/** The public listing hook's own fetch is replaced by the REAL loader's output (set in the test). */
const pub = vi.hoisted(() => ({ rooms: [] as { roomChoice: string; spans: { start: string; end: string | null; count: number }[] }[] }));
vi.mock("@/hooks/use-listing-public-occupancy", () => ({
  useListingPublicOccupancy: () => ({ rooms: pub.rooms, loading: false }),
}));

const grants = vi.hoisted(() => ({ read: new Set<string>() }));
vi.mock("@/lib/auth/manager-lease-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/manager-lease-scope")>()),
  managerHasCalendarAccessForProperty: async (_db: unknown, _u: string, id: string) => grants.read.has(id),
  managerCalendarReadableProperties: async (_db: unknown, _u: string, ids: readonly string[]) =>
    new Set(ids.filter((id) => grants.read.has(id))),
}));

const fake = vi.hoisted(() => ({
  db: null as unknown,
  catalog: [] as Array<Record<string, unknown> & { id: string }>,
  channel: [] as unknown[],
}));

/**
 * The browser-side public catalog the apply wizard resolves room capacity from. Built from the
 * same `listing()` factory the database serves, so the wizard sees the real rooms.
 */
vi.mock("@/data/mock-properties", () => ({
  get mockProperties() {
    return fake.catalog;
  },
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => fake.db }));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: async () => fake.catalog }));
vi.mock("@/lib/channel-calendar/bookings.server", () => ({
  listManagerChannelCalendarBookings: async () => fake.channel,
}));

import { PortfolioPropertiesSection, type PortfolioPropertyCardData } from "@/components/portal/pro-dashboard-portfolio";
import { PropertyHouseDetailsListPanel } from "@/components/portal/property-house-details-list-panel";
import { SpacesInteractive } from "@/components/marketing/listing-detail-tables-client";
import { InboxConversationRow } from "@/components/portal/portal-inbox-ui";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { normalizeHouseInfo } from "@/lib/house-info";
import { occupancySnapshotForManager } from "@/lib/occupancy/snapshot.server";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import { occupiedBedsOn } from "@/lib/room-occupancy-rule";
import {
  dashboardOccupancyDayKeys,
  dashboardOccupancyFromSnapshot,
  dashboardOccupancyUrl,
} from "@/lib/dashboard-occupancy";
import { dashboardPeriods } from "@/lib/dashboard-kpis";
import { roomAvailabilityTextFromOccupancy } from "@/lib/property-record-row-facts";
import { RoomAvailabilityMonthCalendar } from "@/components/room-availability-month-calendar";
import { replacePublicRoomOccupancy } from "@/lib/public-room-occupancy-client";
import { getRoomUnavailabilityWindows, isRoomChoiceAvailable } from "@/lib/rental-application/data";
import {
  checkRoomAvailabilityTool,
  getListingDetailsTool,
  __resetLeasingCatalogCache,
  __resetSmsOccupancyCache,
} from "@/lib/tools/domains/leasing-sms";
import type { AgentContext } from "@/lib/tools/context";
import { parseNameFromInboundText, contactNameRepairVerdict, isPlausibleContactName } from "@/lib/sms/contact-name";
import { communicationListRowName, isSmsNoticeInboxRow } from "@/lib/communication-list-row-name";
import { smsConversationDisplayName } from "@/lib/manager-sms-messages";
import { reduceSmsNoticeRow, asNoticeMarker } from "@/lib/sms-notice-reduction";
import { mergeUnifiedInboxItems, type UnifiedInboxListItem } from "@/lib/unified-inbox-merge";
import { SMS_AUTO_REPLY_AUTHOR } from "@/lib/sms-auto-reply";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

const OUT = process.env.EVIDENCE_DIR ?? "";
const TODAY = "2026-10-11";
const OWNER = "owner-cedar";
const HOUSE = "cedar-1";
const HOUSE_LABEL = "Cedar House · 418 NE 42nd St";

function writeShot(name: string, caption: string, body: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<div class="@container" style="max-width:1180px;margin:16px auto;padding:0 16px 40px">
<p style="font:600 13px/1.6 system-ui;color:#334155;margin:0 0 12px;white-space:pre-line">${caption}</p>
${body}</div></body></html>`,
  );
}

const occupancyLog: string[] = [];
const smsLog: string[] = [];
const say = (line = "") => occupancyLog.push(line);
const sms = (line = "") => smsLog.push(line);

/* ------------------------------------------------------------------ fixture */

type RoomSpec = { id: string; name: string; capacity: number; rent: number; blocked?: { start: string; end: string } };

const ROOMS: RoomSpec[] = [
  { id: "r-signed", name: "Room 1", capacity: 1, rent: 1150 },
  { id: "r-approved", name: "Room 2", capacity: 1, rent: 1100 },
  { id: "r-shared", name: "Room 3 (shared, 2 beds)", capacity: 2, rent: 850 },
  { id: "r-airbnb", name: "Room 4", capacity: 1, rent: 1200 },
  { id: "r-block", name: "Room 5", capacity: 1, rent: 1050 },
  { id: "r-listing", name: "Room 6", capacity: 1, rent: 1000, blocked: { start: "2026-10-01", end: "2026-10-31" } },
  { id: "r-open", name: "Room 7", capacity: 1, rent: 975 },
];

/** Who holds what, in the manager's words — the caption every surface is checked against. */
const HELD_BY: Record<string, string> = {
  "r-signed": "resident with a fully signed lease (Oct 1 2026 – Jun 30 2027)",
  "r-approved": "approved applicant, signature still pending (Oct 5 2026 – Apr 30 2027)",
  "r-shared": "one hand-added resident in one of two beds (Sep 1 2026 – Aug 31 2027)",
  "r-airbnb": "Airbnb reservation (Oct 9 – Oct 18 2026)",
  "r-block": "manager's room block (Oct 10 – Oct 20 2026)",
  "r-listing": "listing's own blocked dates (Oct 1 – Oct 31 2026)",
  "r-open": "nobody",
};

/** Rooms with no bed free on TODAY. r-shared keeps a bed, so it is NOT here. */
const CLOSED_TODAY = ["r-signed", "r-approved", "r-airbnb", "r-block", "r-listing"];
const BEDS_TOTAL = ROOMS.reduce((n, r) => n + r.capacity, 0);
const OCCUPIED_BEDS_TODAY = 6; // five full rooms + one of the shared room's two beds

function listing(): ManagerListingSubmissionV1 {
  const sub = createDefaultListingSubmission();
  sub.rentalStyle = "rooms";
  sub.buildingName = HOUSE_LABEL;
  sub.rooms = ROOMS.map((room) => ({
    ...sub.rooms[0]!,
    id: room.id,
    name: room.name,
    occupancyCapacity: room.capacity,
    monthlyRent: room.rent,
    moveInAvailableDate: "",
    manualUnavailableRanges: room.blocked ? [{ id: `mu-${room.id}`, start: room.blocked.start, end: room.blocked.end }] : [],
  })) as never;
  return sub;
}

const application = (
  id: string,
  roomId: string,
  over: Record<string, unknown>,
) => ({
  id,
  manager_user_id: OWNER,
  property_id: HOUSE,
  assigned_property_id: HOUSE,
  row_data: {
    bucket: "approved",
    assignedPropertyId: HOUSE,
    assignedRoomChoice: `${HOUSE}::${roomId}`,
    ...over,
  },
});

const APPLICATIONS = [
  application("AXIS-CEDAR-SIGNED", "r-signed", {
    name: "Ada Signed",
    email: "ada@example.test",
    application: { leaseStart: "2026-10-01", leaseEnd: "2027-06-30", monthlyRent: 1150 },
  }),
  application("AXIS-CEDAR-APPROVED", "r-approved", {
    name: "Ben Approved",
    email: "ben@example.test",
    application: { leaseStart: "2026-10-05", leaseEnd: "2027-04-30", monthlyRent: 1100 },
  }),
  application("AXIS-CEDAR-ADDED", "r-shared", {
    manuallyAdded: true,
    name: "Cleo Added",
    email: "cleo@example.test",
    manualResidentDetails: { moveInDate: "2026-09-01", moveOutDate: "2027-08-31", monthlyRent: 850, leaseTerm: "long_term" },
  }),
];

/** Fully executed lease for the first resident, stamped by the owner who generated it. */
const LEASES = [
  {
    id: "lease-signed-1",
    manager_user_id: OWNER,
    property_id: HOUSE,
    updated_at: "2026-09-30T00:00:00.000Z",
    row_data: {
      id: "lease-signed-1",
      axisId: "AXIS-CEDAR-SIGNED",
      status: "Fully Signed",
      fullySignedAt: "2026-09-30T00:00:00.000Z",
      propertyId: HOUSE,
      roomChoice: `${HOUSE}::r-signed`,
      application: { leaseStart: "2026-10-01", leaseEnd: "2027-06-30" },
    },
  },
];

/** The manager's typed room block, as a schedule record. */
const BLOCKS = [
  {
    id: "blk-cedar-1",
    manager_user_id: OWNER,
    property_id: HOUSE,
    record_type: "room_date_block",
    row_data: { roomId: "r-block", checkIn: "2026-10-10", checkOut: "2026-10-20", bookingStatus: "confirmed", note: "Repainting" },
  },
];

/**
 * The channel calendar, in BOTH shapes the two readers use: `imported_ranges` on the
 * connection row (the public loader) and the manager booking projection (the snapshot).
 * The second range is PropLane's own export echoing back on top of Cleo's bed.
 */
const CHANNEL_RANGES = [
  { sourceUid: "air-1", start: "2026-10-09", end: "2026-10-18", summary: "Airbnb reservation", guestName: "Bo Guest", reservationCode: "HMX123", provider: "airbnb", roomId: "r-airbnb" },
  { sourceUid: "echo-1", start: "2026-09-01", end: "2027-08-31", summary: "CLOSED - Not available", provider: "airbnb", roomId: "r-shared" },
];

const CONNECTION_ROWS = ["r-airbnb", "r-shared"].map((roomId) => ({
  property_id: HOUSE,
  room_id: roomId,
  manager_user_id: OWNER,
  imported_ranges: CHANNEL_RANGES.filter((range) => range.roomId === roomId),
}));

const CHANNEL_BOOKINGS = [
  {
    propertyId: HOUSE,
    propertyLabel: HOUSE_LABEL,
    rooms: ["r-airbnb", "r-shared"].map((roomId) => ({
      roomId,
      roomLabel: ROOMS.find((r) => r.id === roomId)!.name,
      provider: "airbnb",
      connectionId: `conn-${roomId}`,
      lastSyncedAt: "2026-10-11T06:00:00.000Z",
      ranges: CHANNEL_RANGES.filter((range) => range.roomId === roomId),
    })),
  },
];

const PROPERTY_ROW = {
  id: HOUSE,
  manager_user_id: OWNER,
  status: "live",
  property_data: { buildingName: HOUSE_LABEL, listingSubmission: listing() },
  row_data: null,
};

/**
 * The public loader reads applications through PostgREST computed aliases
 * (`choice:row_data->>assignedRoomChoice`, ...), the manager snapshot reads the whole `row_data`.
 * Both shapes come from the SAME fixture row, so the two readers cannot be fed different facts.
 */
function flatApplication(app: (typeof APPLICATIONS)[number]) {
  const data = app.row_data as Record<string, any>;
  return {
    id: app.id,
    occupancy_start: null,
    manager_user_id: app.manager_user_id,
    property_id: app.property_id,
    assigned_property_id: app.assigned_property_id,
    assigned: data.assignedPropertyId ?? null,
    property: data.propertyId ?? null,
    application_property: data.application?.propertyId ?? null,
    withdrawn: data.withdrawnAt ?? null,
    manually_added: data.manuallyAdded === true ? "true" : null,
    choice: data.assignedRoomChoice ?? null,
    preferred: data.application?.roomChoice1 ?? null,
    manual_room: data.manualResidentDetails?.roomNumber ?? null,
    manual_start: data.manualResidentDetails?.moveInDate ?? null,
    manual_end: data.manualResidentDetails?.moveOutDate ?? null,
    lease_start: data.application?.leaseStart ?? null,
    lease_end: data.application?.leaseEnd ?? null,
  };
}

/** One permissive stub over the real reads; an unknown table throws rather than answering empty. */
function fakeDb(sub: ManagerListingSubmissionV1) {
  const propertyRow = { ...PROPERTY_ROW, property_data: { buildingName: HOUSE_LABEL, listingSubmission: sub } };
  const paged: Record<string, unknown[]> = {
    manager_application_records: APPLICATIONS,
    portal_lease_pipeline_records: LEASES,
    portal_schedule_records: BLOCKS,
    manager_property_records: [propertyRow],
  };
  const listed: Record<string, unknown[]> = {
    manager_property_records: [propertyRow],
    external_calendar_connections: CONNECTION_ROWS,
    account_link_invites: [],
    manager_workspaces: [],
    manager_active_workspace: [],
    portal_lease_pipeline_records: LEASES,
    portal_schedule_records: BLOCKS,
  };
  return {
    from(table: string) {
      const query: Record<string, unknown> = {};
      let selected = "";
      for (const name of ["in", "eq", "neq", "or", "is", "not", "like", "ilike", "gte", "lte", "order", "limit", "contains", "overlaps"]) {
        query[name] = () => query;
      }
      query.select = (columns?: unknown) => {
        selected = String(columns ?? "");
        return query;
      };
      query.maybeSingle = async () => ({
        data: table === "manager_property_records" ? propertyRow : null,
        error: null,
      });
      query.single = query.maybeSingle;
      query.range = (start: number) => {
        const rows =
          table === "manager_application_records" && selected.includes("assignedRoomChoice")
            ? APPLICATIONS.map(flatApplication)
            : paged[table];
        if (!rows) throw new Error(`Unexpected paged table: ${table}`);
        return Promise.resolve({ data: rows.slice(start), error: null });
      };
      query.then = (resolve: (value: unknown) => unknown) => {
        const rows = listed[table];
        if (!rows) throw new Error(`Unexpected table: ${table}`);
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      };
      return query;
    },
  } as never;
}

/* --------------------------------------------------------------- lifecycle */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T19:00:00Z`)); // noon Pacific
  __resetLeasingCatalogCache();
  __resetSmsOccupancyCache();
  const sub = listing();
  fake.db = fakeDb(sub);
  fake.catalog = [{ id: HOUSE, title: "Cedar House", address: "418 NE 42nd St, Seattle, WA", listingSubmission: sub }];
  fake.channel = CHANNEL_BOOKINGS;
  grants.read = new Set([HOUSE]);
  window.localStorage.clear();
  // jsdom starts at "/", which `isDemoModeActive()` treats as the public demo surface;
  // every surface here is the real product, so stand on a real portal path.
  window.history.replaceState({}, "", "/manager/dashboard");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(() => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  if (occupancyLog.length) writeFileSync(`${OUT}/room-occupancy-one-rule.txt`, `${occupancyLog.join("\n")}\n`);
  if (smsLog.length) writeFileSync(`${OUT}/sms-conversation-naming.txt`, `${smsLog.join("\n")}\n`);
});

/* ------------------------------------------------------- part 1: one rule */

type Snapshot = Awaited<ReturnType<typeof occupancySnapshotForManager>>;

async function realSnapshot(days?: readonly string[]): Promise<Snapshot> {
  return occupancySnapshotForManager(fakeDb(listing()), OWNER, {
    propertyIds: [HOUSE],
    from: days?.[0] ?? TODAY,
    to: days?.[days.length - 1] ?? TODAY,
    ...(days ? { days } : {}),
  });
}

describe("evidence · one occupancy rule, four surfaces", () => {
  it("the dashboard card, the room rows, the public listing and the bots all name the same occupied rooms", async () => {
    say("ONE FIXTURE HOUSE — Cedar House · 418 NE 42nd St, 7 rooms / 8 beds");
    say(`today = ${TODAY}`);
    say();
    for (const room of ROOMS) say(`  ${room.name.padEnd(26)} held by ${HELD_BY[room.id]}`);
    say();
    say("Expected from the one rule: 6 of 8 beds taken today. Room 3 keeps a bed because");
    say("PropLane's own \"CLOSED - Not available\" export echoing back is not a second occupant.");
    say();

    /* ---- A. the manager dashboard: property card + Occupancy KPI ---- */
    const periods = dashboardPeriods("month", Date.parse(`${TODAY}T19:00:00Z`), 8);
    const dayKeys = dashboardOccupancyDayKeys(TODAY, periods);
    const snapshot = await realSnapshot(dayKeys);
    const shaped = dashboardOccupancyFromSnapshot(snapshot, TODAY, periods)!;
    expect(shaped.occupiedToday).toBe(OCCUPIED_BEDS_TODAY);
    expect(shaped.byProperty.get(HOUSE)).toBe(OCCUPIED_BEDS_TODAY);
    const kpiPct = Math.round((shaped.occupiedToday / BEDS_TOTAL) * 100);

    say("A · MANAGER DASHBOARD  (real occupancySnapshotForManager -> the card and the KPI)");
    say(`    GET ${dashboardOccupancyUrl([HOUSE], TODAY, periods)}`);
    say(`    ${dayKeys.length} day keys asked for, not the ${periods.length * 31}+ cells the month range would have cost`);
    say(`    property card  "${shaped.occupiedToday} / ${BEDS_TOTAL} occupied"`);
    say(`    Occupancy KPI  ${kpiPct}%  ("Rooms occupied over rentable spaces")`);
    say();

    /* ---- B. the property room rows, from the same snapshot through the route shape ---- */
    const staysForHouse = snapshot.stays
      .filter((stay) => stay.propertyId === HOUSE)
      .map((stay) => ({
        roomId: stay.roomId,
        start: stay.start,
        end: stay.end,
        ...(stay.openEnded ? { openEnded: true as const } : {}),
        ...(stay.echoable ? { echoable: true as const } : {}),
      }));
    const rowText = new Map(
      listing().rooms.map((room) => [room.id, roomAvailabilityTextFromOccupancy(room, staysForHouse, TODAY)] as const),
    );
    say("B · PROPERTY ROOM ROWS  (the same snapshot, through /api/portal/occupancy)");
    for (const room of ROOMS) say(`    ${room.name.padEnd(26)} ${rowText.get(room.id)}`);
    say();
    for (const roomId of CLOSED_TODAY) expect(rowText.get(roomId)).toMatch(/^Occupied/);
    expect(rowText.get("r-shared")).toMatch(/^Available/);
    expect(rowText.get("r-open")).toBe("Available now");

    /* ---- C. the public listing + the apply wizard ---- */
    const sub = listing();
    const publicRooms = await loadPublicRoomOccupancy(fakeDb(sub), [{ id: HOUSE, listingSubmission: sub }], OWNER);
    const bedsToday = new Map(
      publicRooms.map((room) => [room.roomChoice.split("::")[1]!, occupiedBedsOn(room.spans, TODAY)] as const),
    );
    say("C · PUBLIC LISTING + APPLY WIZARD  (real loadPublicRoomOccupancy, anonymous reader)");
    replacePublicRoomOccupancy(publicRooms);
    for (const room of ROOMS) {
      const taken = bedsToday.get(room.id) ?? 0;
      const choice = `${HOUSE}::${room.id}`;
      const free = isRoomChoiceAvailable(choice, "", { leaseStart: TODAY, leaseEnd: TODAY });
      const dateKey = (value: Date | null | undefined) =>
        value ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}` : "open";
      const windows = getRoomUnavailabilityWindows(choice).map((w) => `${dateKey(w.start)}..${dateKey(w.end)}`);
      say(
        `    ${room.name.padEnd(26)} ${taken}/${room.capacity} beds taken today · wizard "Continue" ${free ? "allowed" : "refused"}` +
          (windows.length ? ` · closed ${windows.join(", ")}` : ""),
      );
      expect(taken, `${room.id} public beds`).toBe(CLOSED_TODAY.includes(room.id) ? room.capacity : room.id === "r-shared" ? 1 : 0);
      expect(free, `${room.id} wizard`).toBe(!CLOSED_TODAY.includes(room.id));
    }
    say();

    /* ---- D. the leasing bots ---- */
    const ctx = {
      landlordId: OWNER,
      userId: OWNER,
      email: "",
      roles: ["leasing_sms_agent"],
      isAdmin: false,
      db: fake.db,
      leasingScope: { sessionId: "s1", prospectPhoneE164: "+14255550123", workNumber: "+12065550100", crossCatalog: true },
    } as unknown as AgentContext;

    say("D · LEASING BOTS  (real tool handlers a prospect's text reaches)");
    const botVerdict = new Map<string, boolean | null>();
    for (const room of ROOMS) {
      const out = (await checkRoomAvailabilityTool.handler(ctx, {
        listingId: HOUSE,
        roomId: room.id,
        moveIn: TODAY,
        moveOut: "2026-10-14",
      })) as { found: boolean; ok?: boolean; rooms?: Array<{ available: boolean | null; nextAvailableFrom?: string }> };
      expect(out.found).toBe(true);
      const verdict = out.rooms![0]!;
      botVerdict.set(room.id, verdict.available);
      say(
        `    check_room_availability { roomId: ${room.id}, moveIn: ${TODAY}, moveOut: 2026-10-14 }` +
          `  ->  available=${verdict.available}` +
          (verdict.nextAvailableFrom ? ` nextAvailableFrom=${verdict.nextAvailableFrom}` : ""),
      );
      expect(verdict.available, `${room.id} bot`).toBe(!CLOSED_TODAY.includes(room.id));
    }
    const details = (await getListingDetailsTool.handler(ctx, { propertyId: HOUSE })) as {
      found: boolean;
      listing?: { rooms?: Array<{ id: string; name: string; currentAvailability: string | null; currentAvailabilityVerified: boolean }> };
    };
    expect(details.found).toBe(true);
    const detailRooms = details.listing?.rooms ?? [];
    expect(detailRooms).toHaveLength(ROOMS.length);
    say();
    say("    get_listing_details { propertyId: cedar-1 }  ->  what a prospect is told per room:");
    for (const room of detailRooms) {
      say(`      ${room.name.padEnd(26)} "${room.currentAvailability}"  verified=${room.currentAvailabilityVerified}`);
    }
    // Every room's label is the live occupancy read, never the listing's saved text.
    for (const room of detailRooms) expect(room.currentAvailabilityVerified).toBe(true);
    const labelById = new Map(detailRooms.map((room) => [room.id, String(room.currentAvailability ?? "")] as const));
    for (const roomId of CLOSED_TODAY) expect(labelById.get(roomId), roomId).not.toMatch(/now/i);
    expect(labelById.get("r-shared")).toMatch(/now/i);
    expect(labelById.get("r-open")).toMatch(/now/i);
    say();

    /* ---- the agreement itself ---- */
    const occupiedFrom = {
      "dashboard card / KPI": `${shaped.occupiedToday} of ${BEDS_TOTAL} beds`,
      "room rows": ROOMS.filter((r) => rowText.get(r.id)!.startsWith("Occupied")).map((r) => r.id).join(", "),
      "public listing / wizard": ROOMS.filter((r) => (bedsToday.get(r.id) ?? 0) >= r.capacity).map((r) => r.id).join(", "),
      "leasing bots": ROOMS.filter((r) => botVerdict.get(r.id) === false).map((r) => r.id).join(", "),
    };
    say("AGREEMENT — the rooms with no bed free today, per surface:");
    for (const [surface, value] of Object.entries(occupiedFrom)) say(`    ${surface.padEnd(24)} ${value}`);
    say();
    say(`    expected                 ${CLOSED_TODAY.join(", ")}`);
    expect(occupiedFrom["room rows"]).toBe(CLOSED_TODAY.join(", "));
    expect(occupiedFrom["public listing / wizard"]).toBe(CLOSED_TODAY.join(", "));
    expect(occupiedFrom["leasing bots"]).toBe(CLOSED_TODAY.join(", "));

    /* ---- rendered surfaces ---- */
    const cards: PortfolioPropertyCardData[] = [
      {
        key: HOUSE,
        stage: "listed",
        title: "Cedar House",
        address: "418 NE 42nd St, Seattle, WA",
        spacesLabel: `${BEDS_TOTAL} spaces`,
        spaces: BEDS_TOTAL,
        rentLabel: "$850–$1,200/mo",
        coverUrl: null,
      },
    ];
    const dash = render(
      <div className="space-y-6" style={{ maxWidth: 560 }}>
        {(
          [
            ["the snapshot answered", shaped.byProperty, "ok"],
            ["the read is still in flight", new Map<string, number>(), "loading"],
            ["the read failed", new Map<string, number>(), "failed"],
          ] as const
        ).map(([label, map, state]) => (
          <div key={state}>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
            <PortfolioPropertiesSection cards={cards} basePath="/manager" occupiedByProperty={map} occupancyState={state} />
          </div>
        ))}
      </div>,
    );
    expect(dash.container.querySelector('[aria-label="6 of 8 spaces occupied"]')).toBeTruthy();
    expect(dash.container.querySelector('[aria-label="Loading occupancy"]')).toBeTruthy();
    expect(dash.container.querySelector('[aria-label="Occupancy unavailable"]')).toBeTruthy();
    writeShot(
      "room-truth-dashboard-cards",
      `A · Manager dashboard property card. "${shaped.occupiedToday} / ${BEDS_TOTAL} occupied" is the occupancy snapshot's own count for today — a signed lease, an approved applicant, a hand-added resident, an Airbnb stay, a room block and the listing's blocked dates. Occupancy KPI reads ${kpiPct}%.\nMiddle / right: the read is not yet answered and the read failed — "—", never a confident "0 / 8".`,
      dash.container.innerHTML,
    );
    cleanup();

    // The room rows, rendered by the real panel reading the real route shape.
    const occupancyResponse = await realSnapshot([TODAY]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/portal/occupancy")) {
          return { ok: true, status: 200, json: async () => occupancyResponse } as never;
        }
        return { ok: false, status: 404, json: async () => ({}) } as never;
      }),
    );
    const panel = render(
      <PropertyHouseDetailsListPanel
        propertyId={HOUSE}
        sub={listing()}
        houseInfo={normalizeHouseInfo(undefined)}
        managerNotes=""
        managerUserId={OWNER}
        onPersist={() => true}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const panelText = panel.container.textContent ?? "";
    expect(panelText).toContain("Occupied until");
    writeShot(
      "room-truth-room-rows",
      "B · The property's Rooms rows, drawn by the real panel over /api/portal/occupancy — the same snapshot the dashboard card counted. Each row's availability fact is the occupancy rule's answer, so a hand-added resident, an Airbnb stay and a room block all close a room, and the shared room still reports a free bed.",
      panel.container.innerHTML,
    );
    cleanup();

    // The public room picker: the month calendar a prospect clicks through, built from
    // `getRoomUnavailabilityWindows` exactly as `ListingDetailModal` builds it.
    const calendars = render(
      <div className="grid gap-5 md:grid-cols-2">
        {ROOMS.filter((room) => ["r-airbnb", "r-block", "r-listing", "r-shared"].includes(room.id)).map((room) => (
          <div key={room.id} className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 text-sm font-semibold text-foreground">{room.name}</div>
            <div className="mb-3 text-xs text-muted">{HELD_BY[room.id]}</div>
            <RoomAvailabilityMonthCalendar
              spans={getRoomUnavailabilityWindows(`${HOUSE}::${room.id}`).map((w) => ({ start: w.start, end: w.end, tone: "occupied" as const }))}
            />
          </div>
        ))}
      </div>,
    );
    writeShot(
      "room-truth-public-room-picker",
      "C · The public room picker a prospect clicks, for four of the seven rooms. Red days are the ones the one rule says are taken — an Airbnb reservation, a manager's room block and the listing's own blocked dates all close their room, while the shared room shows no closed day at all because its second bed is free (PropLane's own \"Not available\" export echoing back on top of its resident is not a second occupant).",
      calendars.container.innerHTML,
    );
    cleanup();

    // The public listing's Rooms table, from the real anonymous loader's spans.
    pub.rooms = publicRooms;
    const floorPlans = [
      {
        floorLabel: "Cedar House",
        fromPrice: "$850",
        roomCount: ROOMS.length,
        rooms: ROOMS.map((room) => ({
          id: room.id,
          name: room.name,
          detail: "",
          price: `$${room.rent}/mo`,
          priceMonthlyEquivalent: room.rent,
          occupancyCapacity: room.capacity,
          availability: "Available now",
          bathroomShareCount: 2,
          modal: { photoUrls: [], bathroomShortLabel: "Shared bath" },
        })),
      },
    ];
    const spaces = render(
      <SpacesInteractive
        floorPlans={floorPlans as never}
        bathrooms={[] as never}
        sharedSpaces={[] as never}
        listingPropertyId={HOUSE}
        propertyLabel={HOUSE_LABEL}
      />,
    );
    writeShot(
      "room-truth-public-listing-rooms",
      "C (cont.) · The public listing's Rooms table, fed the REAL loadPublicRoomOccupancy spans. The per-room live availability a prospect acts on is the picker calendar above and the Details modal; this table is the listing's own published row copy, shown here for context.",
      spaces.container.innerHTML,
    );
    cleanup();
  }, 60_000);
});

/* ------------------------------------------- part 2: SMS naming + one row */

const PHONE = "+14259849697";
const PHONE_LABEL = "+1 (425) 984-9697";

const marker = (sid: string, body: string) => ({
  sourceNamespace: "twilio:owner:ACx",
  sourceEventId: sid,
  ownerManagerUserId: OWNER,
  counterpartyRole: "prospect",
  workLineId: "line-1",
  occurredAt: "2026-10-11T21:14:00.000Z",
  bodySha256: createHash("sha256").update(body).digest("hex"),
});

const INBOUND = "Hi I'm looking for a room";

function noticeRow() {
  return {
    id: "sms_notice_0366",
    folder: "inbox",
    from: PHONE,
    email: "",
    subject: `Text from ${PHONE}`,
    unread: true,
    body: INBOUND,
    preview: INBOUND,
    rootAt: "2:14 PM",
    time: "2:15 PM",
    rootMessageId: "leasing_SM1",
    rootOriginalSmsEvent: marker("SM1", INBOUND),
    threadType: "claw_leasing_sms",
    smsNoticePhone: PHONE,
    conversationKey: `tel:${PHONE}`,
    workspaceId: "ws-1",
    messages: [
      {
        id: "auto_reply_SM1",
        from: SMS_AUTO_REPLY_AUTHOR,
        outbound: true,
        channel: "sms",
        at: "2:15 PM",
        body: "Cedar House has 7 rooms; Room 3 has a bed open now.",
      },
    ],
  };
}

const SMS_JOIN_KEY = `sms-conversation:tel:${PHONE}`;

const listItem = (over: Partial<UnifiedInboxListItem>): UnifiedInboxListItem =>
  ({
    key: "k",
    channel: "sms",
    name: "",
    preview: "",
    time: "2:15 PM",
    unread: false,
    sortMs: Date.parse("2026-10-11T21:15:00.000Z"),
    joinKeys: [SMS_JOIN_KEY],
    ...over,
  }) as UnifiedInboxListItem;

describe("evidence · an SMS conversation is named by its person, in one row", () => {
  it("never titles a conversation with a phrase, and lists it once", () => {
    sms("AN UNKNOWN NUMBER TEXTS THE WORK NUMBER");
    sms(`  inbound   "${INBOUND}"   from ${PHONE}`);
    sms();

    /* 1. the name guess */
    const guessed = parseNameFromInboundText(INBOUND);
    expect(guessed).toBe("");
    sms("1 · WHAT THE SYSTEM TAKES AS A NAME");
    sms(`  parseNameFromInboundText("${INBOUND}")  ->  ${JSON.stringify(guessed)}   (was "looking for")`);
    for (const text of [
      "My name is Maya Chen",
      "my name is maya",
      "This is Will",
      "I'm interested in the Brooklyn Ave room",
      "Im a student at UW looking for housing",
      "this is the property manager",
    ]) {
      const name = parseNameFromInboundText(text);
      sms(`  "${text}"`.padEnd(52) + `  ->  ${name ? JSON.stringify(name) : "no name (the row stays the phone number)"}`);
    }
    expect(parseNameFromInboundText("My name is Maya Chen")).toBe("Maya Chen");
    expect(parseNameFromInboundText("I'm interested in the Brooklyn Ave room")).toBe("");
    expect(parseNameFromInboundText("Im a student at UW looking for housing")).toBe("");
    sms();
    sms("  A guess is stored only when it passes isPlausibleContactName AND the contact");
    sms("  has no name yet, so it can never overwrite a manager's own label:");
    for (const candidate of ["Maya Chen", "looking for", "Room 4", "+1 (425) 984-9697"]) {
      sms(`    isPlausibleContactName(${JSON.stringify(candidate)}) -> ${isPlausibleContactName(candidate)}`);
    }
    expect(isPlausibleContactName("looking for")).toBe(false);
    expect(isPlausibleContactName("Maya Chen")).toBe(true);
    sms();

    /* 2. the list title */
    const thread = (over: Record<string, unknown>) =>
      ({ id: "sms_notice_0366", folder: "inbox", from: PHONE, email: "", subject: "", preview: INBOUND, time: "2:15 PM", unread: true, ...over }) as PersistedInboxThread;
    const unknownRow = communicationListRowName(thread({ threadType: "claw_leasing_sms", smsNoticePhone: PHONE }), [], { useFrom: true });
    const assistantAuthored = communicationListRowName(
      thread({ from: SMS_AUTO_REPLY_AUTHOR, threadType: "claw_leasing_sms", smsNoticePhone: PHONE }),
      [],
      { useFrom: true },
    );
    // Once the texter introduces themselves (or a record names them) the SMS projection
    // carries that name as the row's sender, and the list title is the person.
    const named = communicationListRowName(
      thread({ from: "Maya Chen", threadType: "claw_leasing_sms", smsNoticePhone: PHONE }),
      [],
      { useFrom: true },
    );
    sms("2 · THE TITLE COMMUNICATION PUTS ON THE ROW");
    sms(`  no record, no introduction        ->  ${JSON.stringify(unknownRow)}`);
    sms(`  last turn is the auto-reply       ->  ${JSON.stringify(assistantAuthored)}   (never "PropLane Assistant")`);
    sms(`  the person said who they are      ->  ${JSON.stringify(named)}`);
    expect(unknownRow).toBe(PHONE_LABEL);
    expect(assistantAuthored).toBe(PHONE_LABEL);
    expect(named).toBe("Maya Chen");
    sms();
    sms("  And the SMS conversation label itself refuses a stored phrase:");
    for (const stored of ["looking for", "Maya Chen"]) {
      const label = smsConversationDisplayName({
        name: stored,
        directoryName: stored,
        savedContactName: "",
        propertyLabel: "",
        residentEmail: "",
        phone: PHONE,
      });
      sms(`    stored name ${JSON.stringify(stored).padEnd(14)} -> ${JSON.stringify(label)}`);
    }
    expect(
      smsConversationDisplayName({ name: "looking for", directoryName: "looking for", savedContactName: "", propertyLabel: "", residentEmail: "", phone: PHONE }),
    ).toBe(PHONE_LABEL);
    sms();

    /* 3. one row */
    const projected = (m: ReturnType<typeof asNoticeMarker>) => Boolean(m && m.sourceEventId === "SM1");
    const reduced = reduceSmsNoticeRow(noticeRow(), projected);
    expect(reduced).toBeNull();
    sms("3 · ONE ROW PER SMS CONVERSATION");
    sms("  The SMS projection carries the inbound original, so the stored notice copy holds");
    sms("  nothing but the server's own auto-reply echo:");
    sms(`    reduceSmsNoticeRow(stored notice) -> ${reduced === null ? "null (dropped: no second row)" : "a row"}`);
    const keptWithAnnotation = reduceSmsNoticeRow(
      { ...noticeRow(), messages: [...noticeRow().messages, { id: "note-1", from: PHONE, channel: "sms", at: "2:20 PM", body: "Called back" }] },
      projected,
    )!;
    expect(keptWithAnnotation.from).toBe(PHONE);
    sms(`    with a manager annotation         -> kept, from=${JSON.stringify(keptWithAnnotation.from)} (the counterparty, not the assistant)`);
    sms();

    const merged = mergeUnifiedInboxItems([
      listItem({ key: "sms:+14259849697", name: PHONE_LABEL, preview: INBOUND, unread: true, unreadCount: 1, memberKeys: ["sms:+14259849697"] }),
      listItem({ key: "sms_notice_0366", name: PHONE_LABEL, preview: INBOUND, unread: true, unreadCount: 1, smsNotice: true, sortMs: Date.parse("2026-10-11T21:14:00.000Z"), memberKeys: ["sms_notice_0366"] }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.unreadCount).toBe(1);
    sms("  Folded in the list, the projection and the notice are ONE conversation, counted once:");
    sms(`    rows in Communication = ${merged.length}, unread badge = ${merged[0]!.unreadCount}`);
    expect(isSmsNoticeInboxRow(thread({ threadType: "claw_leasing_sms", smsNoticePhone: PHONE }))).toBe(true);
    sms();

    /* 4. the repair */
    sms("4 · THE REPAIR SCRIPT'S VERDICT ON NAMES ALREADY STORED");
    const verdicts: [string, string][] = [];
    for (const name of ["looking for", "interested in", "here", "+1 (425) 984-9697", "Plumber · +14255550123", "Maya Chen", "Guy Fieri", "Joe's Plumbing", "Unit 4"]) {
      const verdict = contactNameRepairVerdict(name);
      verdicts.push([name, verdict.keep ? "kept" : `cleared — ${verdict.reason}`]);
      sms(`    ${JSON.stringify(name).padEnd(28)} ${verdict.keep ? "kept" : `cleared — ${verdict.reason}`}`);
    }
    expect(contactNameRepairVerdict("looking for").keep).toBe(false);
    expect(contactNameRepairVerdict("Guy Fieri").keep).toBe(true);
    expect(contactNameRepairVerdict("Unit 4").keep).toBe(true);

    /* ---- rendered surface: the Communication list rows ---- */
    const before = render(
      <div className="divide-y divide-border rounded-xl border border-border bg-card">
        <InboxConversationRow name="looking for" preview={INBOUND} time="2:15 PM" unread active={false} onClick={() => {}} />
        <InboxConversationRow name="PropLane Assistant" preview="Cedar House has 7 rooms; Room 3 has a bed open now." time="2:15 PM" unread active={false} onClick={() => {}} />
      </div>,
    );
    const beforeHtml = before.container.innerHTML;
    cleanup();
    const afterFirst = render(
      <div className="divide-y divide-border rounded-xl border border-border bg-card">
        <InboxConversationRow name={unknownRow} preview={INBOUND} time="2:15 PM" unread active={false} onClick={() => {}} />
      </div>,
    );
    const afterFirstHtml = afterFirst.container.innerHTML;
    cleanup();
    const afterNamed = render(
      <div className="divide-y divide-border rounded-xl border border-border bg-card">
        <InboxConversationRow name={named} preview="My name is Maya Chen — is Room 3 still open?" time="2:41 PM" unread active={false} onClick={() => {}} />
      </div>,
    );
    writeShot(
      "sms-communication-rows",
      "The SAME texter's conversation in Communication, at three points.\nBefore: the old name guess titled it with the phrase \"looking for\", and the server's own auto-reply left a SECOND row titled \"PropLane Assistant\" for that one conversation.\nAfter: one row, titled by the readable number — and once she says who she is, by her name.",
      `<p style="font:600 12px/1.4 system-ui;color:#b42318;margin:14px 0 6px">BEFORE — two rows for one texter, one of them titled by a phrase</p>${beforeHtml}
<p style="font:600 12px/1.4 system-ui;color:#067647;margin:20px 0 6px">AFTER — her first text: one row, titled by the number</p>${afterFirstHtml}
<p style="font:600 12px/1.4 system-ui;color:#067647;margin:20px 0 6px">AFTER — "My name is Maya Chen": the same one row, now titled by her</p>${afterNamed.container.innerHTML}`,
    );
    expect(verdicts.length).toBeGreaterThan(0);
  });
});
