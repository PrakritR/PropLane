// @vitest-environment jsdom
/**
 * Evidence harness — claude-2/bookings-residents-1016 (2026-10-16).
 *
 * The four things the captain asked for, driven through the real product code:
 *  1. every booking has a name — the Add booking sheet will not save without one,
 *     and a room with no guest is "Closed (no guest)" with a reason;
 *  2. a resident reads In-house (today) / Confirmed (future), never "Hold";
 *  3. an Airbnb "Reserved" reservation becomes a NAMED resident, and the calendar
 *     draws that reservation once — the channel bar it covers is dropped;
 *  4. (see `evidence-owner-booking-email-1016.test.ts`) the owner is emailed.
 *
 * Nothing about the data is restated: the resident row is the one the REAL
 * `upsertAirbnbResidentsFromImportedRanges` writes, it is read back through the REAL
 * `occupancySnapshotForManager`, and the rows/bars are the REAL `ManagerBookingsWorkspace`
 * over the REAL `useManagerBookingEntries`.
 *
 * With EVIDENCE_DIR set it writes screenshot-ready HTML plus a transcript:
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-bookings-residents-1016.test.tsx
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "owner-1", email: "owner@seattlehomes.test", ready: true }),
}));
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-property-pipeline")>()),
  syncPropertyPipelineFromServer: () => Promise.resolve(),
}));
vi.mock("@/lib/channel-calendar/stay-meta-client", () => ({
  fetchStayMetas: () => Promise.resolve([]),
  saveStayMeta: () => Promise.resolve(),
}));
vi.mock("@/lib/lease-pipeline-storage", () => ({
  LEASE_PIPELINE_EVENT: "lease-pipeline-changed",
  leasePipelineReadSucceeded: () => true,
  leaseIsFullyExecuted: () => false,
  readLeasePipeline: () => [],
  syncLeasePipelineFromServer: () => Promise.resolve([]),
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  normalizeApplicationAxisId: (id: unknown) => String(id ?? ""),
  readManagerApplicationRows: () => [],
  syncManagerApplicationsFromServerWithStatus: () => Promise.resolve({ rows: [], ok: true, complete: true }),
}));
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: (id: string) => (id === "seattle-homes-1" ? { id, listingSubmission: LISTING } : null),
  isEntireHomeProperty: () => false,
  parseRoomChoiceValue: (value: string) => ({ listingRoomId: value.includes("::") ? value.split("::")[1]! : null }),
  getRoomOptionsForProperty: () => ROOM_OPTIONS,
}));

const blocksRead = vi.fn<() => Promise<unknown[]>>(async () => []);
vi.mock("@/lib/channel-calendar/room-date-blocks", () => ({
  ROOM_DATE_BLOCKS_CHANGED: "axis:room-date-blocks-changed",
  fetchRoomDateBlocks: () => blocksRead(),
  saveRoomDateBlock: () => Promise.resolve({ id: "b1" }),
  deleteRoomDateBlock: () => Promise.resolve(),
}));

const channelRead = vi.fn<() => Promise<unknown[]>>(async () => []);
const occupancyFetch = vi.fn<() => Promise<unknown>>();
vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: () => channelRead(),
  fetchOccupancySnapshot: () => occupancyFetch(),
  fetchWritableChannelCalendarPropertyIds: (ids: string[]) => Promise.resolve(ids),
  fetchChannelCalendarConnections: () => Promise.resolve([]),
  saveManagerChannelCalendarLink: () => Promise.resolve({ ok: true }),
  saveChannelCalendarConnection: () => Promise.resolve({ id: "c1" }),
  syncChannelCalendarConnection: () => Promise.resolve(),
  deleteChannelCalendarConnection: () => Promise.resolve(),
}));

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerBookingsWorkspace } from "@/components/portal/pro-bookings";
import { BookingsBlockDatesModal } from "@/components/portal/bookings-block-dates-modal";
import { clearAllWorkspaceDrafts } from "@/components/portal/add-workspace/draft";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { occupancySnapshotForManager } from "@/lib/occupancy/snapshot.server";
import { upsertAirbnbResidentsFromImportedRanges } from "@/lib/channel-calendar/airbnb-residents.server";
import { icalGuestStaysForResidents } from "@/lib/channel-calendar/airbnb-residents";
import { isIcalAvailabilityBlock } from "@/lib/occupancy/snapshot";

/* ───────────────────────── the workspace ───────────────────────── */

const OWNER = "owner-1";
const HOUSE = "seattle-homes-1";
const HOUSE_LABEL = "Seattle Homes · 5259 Brooklyn Ave NE";
const CONNECTION = "conn-airbnb-1";
const AIRBNB_UID = "airbnb-uid-9f31";
const AIRBNB_CODE = "HMHW5SHXRB";
const TODAY = "2026-10-16";

const ROOMS = [
  { id: "room-1", name: "Room 1" },
  { id: "room-2", name: "Room 2" },
  { id: "room-3", name: "Room 3" },
  { id: "room-4", name: "Room 4" },
];
const ROOM_OPTIONS = ROOMS.map((room) => ({ value: `${HOUSE}::${room.id}`, label: room.name }));

const LISTING = (() => {
  const submission = createDefaultListingSubmission();
  submission.rentalStyle = "rooms";
  submission.rooms = ROOMS.map((room) => ({ ...submission.rooms[0]!, id: room.id, name: room.name, occupancyCapacity: 1 }));
  return submission;
})();

/** Airbnb's own feed for Room 3: one real reservation, which Airbnb always writes as "Reserved". */
const AIRBNB_RANGE = {
  id: AIRBNB_UID,
  sourceUid: AIRBNB_UID,
  summary: "Reserved",
  start: "2026-10-14",
  end: "2026-10-19",
  reservationCode: AIRBNB_CODE,
};
const CHANNEL_BOOKINGS = [
  {
    propertyId: HOUSE,
    propertyLabel: HOUSE_LABEL,
    rooms: [
      {
        connectionId: CONNECTION,
        roomId: "room-3",
        roomLabel: "Room 3",
        provider: "airbnb" as const,
        label: "Airbnb · Room 3",
        ranges: [AIRBNB_RANGE],
        lastSyncedAt: "2026-10-16T06:00:00.000Z",
        lastError: null,
        hasImportUrl: true,
        importUrl: null,
        exportUrl: "https://app.test/feed.ics",
      },
    ],
  },
];

/** Two residents typed into PropLane: one living there today, one arriving next month. */
const manualResident = (input: { id: string; name: string; room: string; moveIn: string; moveOut: string; rent: number }) => ({
  id: input.id,
  manager_user_id: OWNER,
  property_id: HOUSE,
  assigned_property_id: HOUSE,
  row_data: {
    bucket: "approved",
    manuallyAdded: true,
    name: input.name,
    email: `${input.name.split(" ")[0]!.toLowerCase()}@example.test`,
    assignedPropertyId: HOUSE,
    assignedRoomChoice: `${HOUSE}::${input.room}`,
    manualResidentDetails: {
      roomNumber: ROOMS.find((room) => room.id === input.room)!.name,
      moveInDate: input.moveIn,
      moveOutDate: input.moveOut,
      monthlyRent: input.rent,
      securityDeposit: 500,
      leaseTerm: "long_term",
      phone: "+12065550101",
    },
  },
});

const RESIDENT_ROWS = [
  manualResident({ id: "AXIS-SEA-01", name: "Maya Chen", room: "room-1", moveIn: "2026-10-01", moveOut: "2027-03-31", rent: 1250 }),
  manualResident({ id: "AXIS-SEA-02", name: "Daniel Reyes", room: "room-2", moveIn: "2026-11-05", moveOut: "2027-05-04", rent: 1180 }),
];

/** Room 4: a named native hold (still "Hold") and a room the manager closed with a reason. */
const NATIVE_BLOCKS = [
  {
    id: "block-hold-1",
    propertyId: HOUSE,
    roomId: "room-4",
    checkIn: "2026-10-20",
    checkOut: "2026-10-26",
    reason: "",
    residentName: "Priya Shah",
    residentEmail: "priya@example.test",
    bookingStatus: "hold" as const,
    createdAt: "2026-10-15T10:00:00.000Z",
  },
  {
    id: "block-closed-1",
    propertyId: HOUSE,
    roomId: "room-4",
    checkIn: "2026-10-28",
    checkOut: "2026-10-31",
    reason: "Painting",
    blockKind: "closed" as const,
    createdAt: "2026-10-15T10:05:00.000Z",
  },
];

/* ───────────────────── the fake databases ───────────────────── */

type Row = Record<string, unknown>;

/** Reads `row_data->>key` like PostgREST does; every other column is a plain key. */
function column(row: Row, col: string): unknown {
  const at = col.indexOf("->>");
  if (at < 0) return row[col];
  const data = row[col.slice(0, at)] as Row | undefined;
  return data?.[col.slice(at + 3)];
}

/** Just the chain shapes the Airbnb resident writer issues. Shared with `airbnb-resident-from-booking.test.ts`. */
function syncDb(tables: Record<string, Row[]>): SupabaseClient {
  const from = (table: string) => {
    const master = (tables[table] ??= []);
    let working = [...master];
    let op: "select" | "upsert" | "update" = "select";
    let payload: Row = {};
    let conflict = "id";
    const q: Record<string, unknown> = {
      select: () => q,
      limit: () => q,
      eq: (col: string, val: unknown) => {
        working = working.filter((row) => column(row, col) === val);
        return q;
      },
      upsert: (row: Row, opts?: { onConflict?: string }) => {
        op = "upsert";
        payload = row;
        conflict = opts?.onConflict ?? "id";
        return q;
      },
      update: (patch: Row) => {
        op = "update";
        payload = patch;
        return q;
      },
      maybeSingle: async () => ({ data: working[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => {
        if (op === "upsert") {
          const keys = conflict.split(",").map((key) => key.trim());
          const existing = master.find((row) => keys.every((key) => row[key] === payload[key]));
          if (existing) Object.assign(existing, payload);
          else master.push({ ...payload });
        } else if (op === "update") {
          for (const row of working) Object.assign(row, payload);
        }
        return Promise.resolve({ data: op === "select" ? working : null, error: null }).then(resolve, reject);
      },
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

/** The read side `occupancySnapshotForManager` issues: the house's listing plus its application rows. */
function snapshotDb(applications: Row[]) {
  return {
    from(table: string) {
      let ownerFilter: string | null = null;
      const query = {
        select() { return this; },
        in() { return this; },
        eq(col: string, value: string) {
          if (col === "manager_user_id") ownerFilter = value;
          return this;
        },
        neq() { return this; },
        or() { return this; },
        is() { return this; },
        like() { return this; },
        order() { return this; },
        limit() { return this; },
        maybeSingle() {
          return Promise.resolve({
            data:
              table === "manager_property_records"
                ? { id: HOUSE, manager_user_id: OWNER, property_data: { buildingName: HOUSE_LABEL, listingSubmission: LISTING } }
                : null,
            error: null,
          });
        },
        range(start: number) {
          return Promise.resolve({ data: table === "manager_application_records" ? applications.slice(start) : [], error: null });
        },
        then(resolve: (value: unknown) => unknown) {
          const data =
            table === "manager_property_records"
              ? [{ id: HOUSE, manager_user_id: OWNER, property_data: { listingSubmission: LISTING } }].filter(
                  (row) => !ownerFilter || row.manager_user_id === ownerFilter,
                )
              : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
  } as never;
}

/* ───────────────────── evidence writers ───────────────────── */

const OUT = process.env.EVIDENCE_DIR ?? "";
const log: string[] = [];
const say = (line = "") => log.push(line);

function writeShot(name: string, caption: string, body: string, width = 1180) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<div style="max-width:${width}px;margin:16px auto;padding:0 16px 48px">
<p style="position:relative;z-index:2147483647;background:#fff;border-radius:8px;padding:10px 12px;font:600 13px/1.5 system-ui;color:#475569;margin:0 0 12px;white-space:pre-line">${caption}</p>
${body}</div></body></html>`,
    "utf8",
  );
}

/** Mirrors live form state onto a clone so a typed input shows its value in the screenshot. */
function bodyShot(): string {
  const clone = document.body.cloneNode(true) as HTMLElement;
  const live = [...document.body.querySelectorAll("input")];
  const copies = [...clone.querySelectorAll("input")];
  live.forEach((input, index) => copies[index]?.setAttribute("value", input.value));
  return clone.innerHTML;
}

/* ───────────────────────── the run ───────────────────────── */

let syncedResidentRow: Row | null = null;

async function realSnapshot(applications: Row[]) {
  return occupancySnapshotForManager(snapshotDb(applications), OWNER, {
    propertyIds: [HOUSE],
    from: "2026-10-01",
    to: "2026-11-30",
  });
}

async function renderBookings(bucket: "inhouse" | "upcoming" | "calendar") {
  const view = render(
    <AppUiProvider>
      <ManagerBookingsWorkspace
        bucket={bucket}
        propertyIds={[HOUSE]}
        propertyOptions={[{ id: HOUSE, label: HOUSE_LABEL }]}
        propertyTick={0}
        refreshSignal={0}
      />
    </AppUiProvider>,
  );
  for (let i = 0; i < 8; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
  return view;
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T19:00:00.000Z`));
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
});
afterAll(() => {
  vi.useRealTimers();
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/bookings-residents-1016.txt`, `${log.join("\n")}\n`);
  }
});
afterEach(() => {
  cleanup();
  clearAllWorkspaceDrafts();
});

describe("evidence · every Airbnb booking becomes a named resident", () => {
  it("the sync files a resident for a 'Reserved' reservation, names it from the code, then from the guest name", async () => {
    say(`PropLane · Bookings — residents, names and the owner's email (${TODAY})`);
    say(`Workspace: ${HOUSE_LABEL}, owner owner@seattlehomes.test`);
    say();
    say("1 · AIRBNB RESERVATION -> RESIDENT (real upsertAirbnbResidentsFromImportedRanges)");
    say(`  Airbnb feed range: summary "${AIRBNB_RANGE.summary}", ${AIRBNB_RANGE.start} -> ${AIRBNB_RANGE.end}, code ${AIRBNB_CODE}`);
    // Why nothing was filed before: "Reserved" is read as an availability block everywhere else.
    expect(isIcalAvailabilityBlock("Reserved")).toBe(true);
    say('  BEFORE: isIcalAvailabilityBlock("Reserved") === true, so the reservation was filtered out');
    say("          and no resident was ever created for it.");

    const stays = icalGuestStaysForResidents(CONNECTION, [AIRBNB_RANGE]);
    expect(stays).toHaveLength(1);

    const tables: Record<string, Row[]> = { manager_application_records: [], channel_stay_details: [] };
    const first = await upsertAirbnbResidentsFromImportedRanges(syncDb(tables), {
      managerUserId: OWNER,
      propertyId: HOUSE,
      propertyLabel: HOUSE_LABEL,
      roomId: "room-3",
      roomLabel: "Room 3",
      connectionId: CONNECTION,
      ranges: [AIRBNB_RANGE],
    });
    expect(first).toMatchObject({ created: 1, skipped: 0 });
    const filed = tables.manager_application_records[0]!;
    const filedData = filed.row_data as Row;
    say(`  AFTER, first sync: created=${first.created} updated=${first.updated} skipped=${first.skipped}`);
    say(`    manager_application_records row -> resident_email: ${String(filed.resident_email)}`);
    say(`      name: "${String(filedData.name)}"   bucket: ${String(filedData.bucket)}   room: ${String(filedData.assignedRoomChoice)}`);
    say(`      icalConnectionId: ${String(filedData.icalConnectionId)}   icalSourceUid: ${String(filedData.icalSourceUid)}`);
    say(`      moveIn/moveOut: ${String((filedData.manualResidentDetails as Row).moveInDate)} -> ${String((filedData.manualResidentDetails as Row).moveOutDate)}`);
    expect(filedData.name).toBe(`Airbnb guest · ${AIRBNB_CODE}`);
    expect(String(filedData.name).toLowerCase()).not.toBe("reserved");

    // Airbnb's confirmation email lands and `applyAirbnbEmailToStay` saves the guest's name on the
    // stay (`channel_stay_details.guest_name`); that name always wins over the invented one.
    tables.channel_stay_details = [{ connection_id: CONNECTION, source_uid: AIRBNB_UID, guest_name: "Juan Angel" }];
    const second = await upsertAirbnbResidentsFromImportedRanges(syncDb(tables), {
      managerUserId: OWNER,
      propertyId: HOUSE,
      propertyLabel: HOUSE_LABEL,
      roomId: "room-3",
      roomLabel: "Room 3",
      connectionId: CONNECTION,
      ranges: [AIRBNB_RANGE],
    });
    expect(second).toMatchObject({ created: 0, updated: 1 });
    const named = tables.manager_application_records[0]!;
    expect((named.row_data as Row).name).toBe("Juan Angel");
    say(`  AFTER, a guest name on the stay (channel_stay_details.guest_name, what the Airbnb email intake`);
    say(`         writes): name: "${String((named.row_data as Row).name)}" — the same row, updated=${second.updated}, never re-created.`);
    say();
    syncedResidentRow = named;
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(`${OUT}/airbnb-resident-row.json`, `${JSON.stringify(named, null, 2)}\n`, "utf8");
    }
  });
});

describe("evidence · Bookings reads In-house, and one reservation draws once", () => {
  it("BEFORE: with no resident filed, Room 3 is an unnamed Airbnb bar and nobody is in-house there", async () => {
    occupancyFetch.mockResolvedValue(await realSnapshot(RESIDENT_ROWS));
    channelRead.mockResolvedValue(CHANNEL_BOOKINGS);
    blocksRead.mockResolvedValue(NATIVE_BLOCKS);

    const view = await renderBookings("inhouse");
    const text = (view.container.textContent ?? "").replace(/\s+/g, " ");
    const rows = [...view.container.querySelectorAll('[data-attr^="bookings-list-row-"]')];

    say("2 · BOOKINGS -> In-house, BEFORE (the Airbnb reservation filed no resident)");
    for (const row of rows) say(`    ${(row.textContent ?? "").replace(/\s+/g, " ").trim()}`);
    say();
    expect(text).toContain("Maya Chen");
    expect(text).not.toContain("Juan Angel");
    writeShot(
      "bookings-before-airbnb-unnamed",
      `BEFORE — Manager portal → Bookings → In-house, ${HOUSE_LABEL} (today ${TODAY}).\nRoom 3 is let on Airbnb Oct 14–19, but an Airbnb "Reserved" range filed no resident at all: the only row for it is the channel's own bar, standing in with the confirmation code. There is no resident account, nobody to message, and nothing to rename. Maya Chen (Room 1) is the lone real resident.`,
      view.container.innerHTML,
    );
  });

  it("the resident and the channel bar are ONE reservation: unlinked they draw twice", async () => {
    // The same resident row, with the feed link stripped: what the calendar would draw if the
    // resident did not carry the reservation's connection + UID.
    const unlinked = { ...syncedResidentRow! };
    const rowData = { ...(unlinked.row_data as Row) };
    delete rowData.icalSourceUid;
    delete rowData.icalConnectionId;
    unlinked.row_data = rowData;
    occupancyFetch.mockResolvedValue(await realSnapshot([...RESIDENT_ROWS, unlinked]));
    channelRead.mockResolvedValue(CHANNEL_BOOKINGS);
    blocksRead.mockResolvedValue(NATIVE_BLOCKS);

    const view = await renderBookings("inhouse");
    const rowText = [...view.container.querySelectorAll('[data-attr^="bookings-list-row-"]')].map((row) =>
      (row.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
    say("2b · the same reservation WITHOUT the resident -> channel link (what the dedupe prevents)");
    for (const line of rowText) say(`    ${line}`);
    say();
    // Room 3's single reservation draws twice: the resident and the channel bar.
    expect(rowText.filter((line) => line.includes("Room 3"))).toHaveLength(2);
    writeShot(
      "bookings-double-row-without-dedupe",
      `What the dedupe prevents — Manager portal → Bookings → In-house, ${HOUSE_LABEL} (today ${TODAY}).\nOne Airbnb reservation, drawn twice: the resident filed for it AND the channel's own bar. Because the synced resident carries the feed's connection id and event UID, the real screen drops the bar it stands in for (next shot).`,
      view.container.innerHTML,
    );
  });

  it("AFTER: the Airbnb guest is a named In-house resident and the channel bar it covers is gone", async () => {
    expect(syncedResidentRow).not.toBeNull();
    // The row the real sync wrote, read back through the real snapshot — nothing re-typed.
    occupancyFetch.mockResolvedValue(await realSnapshot([...RESIDENT_ROWS, syncedResidentRow!]));
    channelRead.mockResolvedValue(CHANNEL_BOOKINGS);
    blocksRead.mockResolvedValue(NATIVE_BLOCKS);

    const view = await renderBookings("inhouse");
    const text = (view.container.textContent ?? "").replace(/\s+/g, " ");
    const rows = [...view.container.querySelectorAll('[data-attr^="bookings-list-row-"]')];
    const rowText = rows.map((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim());

    say("3 · BOOKINGS -> In-house, AFTER");
    for (const line of rowText) say(`    ${line}`);
    say(`    tab count on screen: In-house ${/In-house\s*(\d+)/.exec(text)?.[1] ?? "(not shown)"}`);
    say();

    // The guest is a named resident, reading In-house (their dates cover today), drawn ONCE.
    expect(rowText.filter((line) => line.includes("Juan Angel"))).toHaveLength(1);
    expect(rowText.some((line) => line.includes("Juan Angel") && line.includes("In-house"))).toBe(true);
    expect(rowText.some((line) => line.includes("Maya Chen") && line.includes("In-house"))).toBe(true);
    // No "Hold" on a resident, and no leftover unnamed channel row for the same reservation.
    expect(rowText.filter((line) => /Hold/.test(line))).toHaveLength(0);
    expect(rowText.filter((line) => /Airbnb/i.test(line))).toHaveLength(0);

    writeShot(
      "bookings-after-in-house-named",
      `AFTER — Manager portal → Bookings → In-house, ${HOUSE_LABEL} (today ${TODAY}).\nThe Airbnb reservation is now the resident "Juan Angel" (Room 3, Oct 14–19) and reads In-house, not Hold; the channel bar it stands in for is dropped, so the reservation draws exactly once. Maya Chen reads In-house too.`,
      view.container.innerHTML,
    );
  });

  it("Upcoming: a resident whose dates have not started reads Confirmed, a pending native block reads Hold", async () => {
    occupancyFetch.mockResolvedValue(await realSnapshot([...RESIDENT_ROWS, syncedResidentRow!]));
    channelRead.mockResolvedValue(CHANNEL_BOOKINGS);
    blocksRead.mockResolvedValue(NATIVE_BLOCKS);

    const view = await renderBookings("upcoming");
    const rowText = [...view.container.querySelectorAll('[data-attr^="bookings-list-row-"]')].map((row) =>
      (row.textContent ?? "").replace(/\s+/g, " ").trim(),
    );

    say("4 · BOOKINGS -> Upcoming");
    for (const line of rowText) say(`    ${line}`);
    say();

    // The future resident is Confirmed; "Hold" is left for a pending native block only.
    expect(rowText.some((line) => line.includes("Daniel Reyes") && line.includes("Confirmed"))).toBe(true);
    expect(rowText.some((line) => line.includes("Priya Shah") && line.includes("Hold"))).toBe(true);
    // The closed room draws under its reason, and reads the same "Blocked" the calendar bar says.
    expect(rowText.some((line) => line.includes("Painting") && line.includes("Blocked"))).toBe(true);

    writeShot(
      "bookings-upcoming-confirmed-vs-hold",
      `Manager portal → Bookings → Upcoming, ${HOUSE_LABEL} (today ${TODAY}).\nDaniel Reyes is an approved resident arriving Nov 5 — he reads Confirmed, not Hold. "Hold" is left for the pending native block (Priya Shah, Room 4). The closed room draws under its reason, "Painting", and reads Blocked — the same word the calendar bar uses (bookingStatusLabel).`,
      view.container.innerHTML,
    );
  });

  it("Calendar: one bar per reservation, named, with the resident's status", async () => {
    occupancyFetch.mockResolvedValue(await realSnapshot([...RESIDENT_ROWS, syncedResidentRow!]));
    channelRead.mockResolvedValue(CHANNEL_BOOKINGS);
    blocksRead.mockResolvedValue(NATIVE_BLOCKS);

    const view = await renderBookings("calendar");
    const bars = [...document.querySelectorAll('[data-attr="bookings-calendar-bar"]')];
    const labels = bars.map((bar) => `${bar.getAttribute("aria-label") ?? ""} ${bar.textContent ?? ""}`.replace(/\s+/g, " ").trim());

    const band = (view.container.textContent ?? "").replace(/\s+/g, " ");
    // Four KPI tiles (value over label); beds are "on the focus day / bed count", never a peak beside an average.
    const staying = "2Staying2Check-ins1Check-outs";
    const occupied = "2/4Tonight";
    say("5 · BOOKINGS -> Calendar");
    say(`    band: ${band.includes(staying) ? staying : "(not shown)"} — ${band.includes(occupied) ? occupied : "(not shown)"}`);
    // Residents count as staying and as an occupied bed: Maya Chen (Room 1) and the Airbnb guest (Room 3).
    expect(band).toContain(staying);
    expect(band).toContain(occupied);
    say("    bars:");
    for (const label of labels) say(`    ${label}`);
    say();

    expect(labels.filter((label) => label.includes("Juan Angel"))).toHaveLength(1);
    expect(labels.some((label) => /reserved/i.test(label))).toBe(false);
    // A resident is In-house / Confirmed, a pending native block is Hold, a closed room is Blocked.
    expect(labels.some((label) => label.includes("Maya Chen") && label.includes("In-house"))).toBe(true);
    expect(labels.some((label) => label.includes("Priya Shah") && label.includes("Hold"))).toBe(true);
    expect(labels.some((label) => label.includes("Painting") && label.includes("Blocked"))).toBe(true);

    writeShot(
      "bookings-calendar-one-named-bar",
      `Manager portal → Bookings → Calendar, ${HOUSE_LABEL} (today ${TODAY}).\nThe Airbnb reservation draws one bar, under the guest's name, and nothing reads "Reserved".`,
      view.container.innerHTML,
    );
  });
});

describe("evidence · every booking has a name", () => {
  const RESIDENT_OPTIONS = [
    { key: "email:maya@example.test", name: "Maya Chen", email: "maya@example.test", meta: `Room 1 · ${HOUSE_LABEL}` },
  ];

  function openSheet() {
    const onSave = vi.fn(() => Promise.resolve());
    const view = render(
      <AppUiProvider>
        <BookingsBlockDatesModal
          open
          onClose={() => {}}
          propertyOptions={[{ id: HOUSE, label: HOUSE_LABEL }]}
          initialPropertyId={HOUSE}
          initialDayKey="2026-11-10"
          entries={[]}
          residentOptions={RESIDENT_OPTIONS}
          onSave={onSave}
        />
      </AppUiProvider>,
    );
    return { view, onSave };
  }
  const attr = (name: string) => document.querySelector(`[data-attr="${name}"]`) as HTMLElement | null;
  const step = (id: string) => fireEvent.click(attr(`listing-v2-rail-${id}`)!);
  const saveButton = () => attr("bookings-block-dates-save") as HTMLButtonElement;
  function pick(trigger: HTMLElement, value: string) {
    fireEvent.click(trigger);
    const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    const option = listbox.querySelector(`[data-field-select-option-value="${value}"]`)!;
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
  }

  it("Add booking will not save with nobody named, and offers Closed (no guest) instead", () => {
    openSheet();
    step("property");
    pick(attr("bookings-block-room")!, `${HOUSE}::room-3`);
    const select = attr("bookings-block-resident")!;
    fireEvent.click(select);
    const listbox = document.getElementById(select.getAttribute("aria-controls")!)!;
    const options = [...listbox.querySelectorAll('[role="option"]')].map((option) => (option.textContent ?? "").replace(/^✓/, "").trim());

    say("6 · ADD BOOKING -> Resident, the only four choices");
    for (const option of options) say(`    ${option}`);
    expect(options).toEqual(["Select resident", `Maya Chen · Room 1 · ${HOUSE_LABEL}`, "+ New resident…", "Closed (no guest)"]);
    fireEvent.click(select);
    writeShot(
      "add-booking-resident-choices",
      `Manager portal → Bookings → Add booking → Property, Room 3.\nThe Resident picker has no "No one — just close the room" escape any more. Its only choices are: ${options.join(" / ")}.`,
      bodyShot(),
      980,
    );

    step("review");
    say(`    Add booking with nobody picked -> button disabled: ${saveButton().disabled}`);
    say();
    expect(saveButton().disabled).toBe(true);
    writeShot(
      "add-booking-no-name-blocked",
      "Manager portal → Bookings → Add booking → Review, with nobody picked.\nThe summary reads \"—\" for the resident and Add booking is disabled: a booking with no name cannot be saved.",
      bodyShot(),
      980,
    );
  });

  it("Closed (no guest) needs a reason, and refuses the Airbnb / Booking import markers", async () => {
    const { onSave } = openSheet();
    step("property");
    pick(attr("bookings-block-room")!, `${HOUSE}::room-3`);
    pick(attr("bookings-block-resident")!, "__closed__");
    const reason = attr("bookings-block-closed-reason")!;
    writeShot(
      "closed-room-reason-field",
      "Manager portal → Bookings → Add booking → Property, Room 3 with \"Closed (no guest)\" picked.\nPicking Closed replaces the guest with a Reason field — the room is shut and the reason says why.",
      bodyShot(),
      980,
    );

    step("review");
    say("7 · ADD BOOKING -> Closed (no guest)");
    say(`    reason "" -> Add booking disabled: ${saveButton().disabled}`);
    expect(saveButton().disabled).toBe(true);
    writeShot(
      "closed-room-reason-required",
      "Manager portal → Bookings → Add booking → Review, Closed (no guest) with no reason yet.\nThe resident line reads \"Closed\" and Add booking stays disabled until a reason is typed.",
      bodyShot(),
      980,
    );

    step("property");
    fireEvent.change(reason, { target: { value: "Airbnb" } });
    writeShot(
      "closed-room-reason-airbnb-typed",
      'Manager portal → Bookings → Add booking → Property, Closed (no guest) with the reason "Airbnb".\nThe field is marked invalid: "Airbnb" and "Booking" are the markers that say a block came from a channel import, so they cannot be a reason for closing a room.',
      bodyShot(),
      980,
    );
    step("review");
    say(`    reason "Airbnb" (the import marker) -> Add booking disabled: ${saveButton().disabled}`);
    expect(saveButton().disabled).toBe(true);
    writeShot(
      "closed-room-reason-airbnb-refused",
      'Manager portal → Bookings → Add booking, Closed (no guest) with the reason "Airbnb".\n"Airbnb" and "Booking" are the import markers for a synced channel stay, so they are refused as a reason for closing a room — Add booking stays disabled.',
      bodyShot(),
      980,
    );

    step("property");
    fireEvent.change(reason, { target: { value: "Painting" } });
    step("review");
    say(`    reason "Painting" -> Add booking disabled: ${saveButton().disabled}`);
    writeShot(
      "closed-room-reason-painting-ok",
      'Manager portal → Bookings → Add booking → Review, Closed (no guest) · "Painting".\nA real reason enables Add booking; it saves blockKind "closed" with no name, email or phone.',
      bodyShot(),
      980,
    );
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0]![0] as Record<string, unknown>;
    say(`    saved: ${JSON.stringify({ blockKind: saved.blockKind, reason: saved.reason, residentName: saved.residentName })}`);
    say();
    expect(saved).toMatchObject({ blockKind: "closed", reason: "Painting", residentName: "" });
  });
});
