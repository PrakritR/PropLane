// @vitest-environment jsdom
/**
 * Evidence harness — Bookings shows every resident off the occupancy snapshot (2026-10-10).
 *
 * The complaint: a workspace with fifteen residents drew an EMPTY Bookings list, because the
 * residents were rebuilt from `/api/manager-applications`, a read that takes ~30s on the live
 * portfolio (and is abandoned at 12s by the portal read timeout). Residents now come from
 * `/api/portal/occupancy` instead, so they draw as soon as that answers.
 *
 * Nothing about the data is restated here: the snapshot handed to the client is the REAL
 * `occupancySnapshotForManager` output over a fake database of fifteen approved residents, the
 * hook under the page is the real `useManagerBookingEntries`, and the rows are the real
 * `ManagerBookingsWorkspace`. The applications and lease reads never answer, exactly as they
 * behaved on the live portfolio.
 *
 * With EVIDENCE_DIR set it writes the two rendered lists (before/after) plus a transcript.
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-bookings-residents-occupancy-1010.test.tsx
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "owner-1", email: "owner@seattlehomes.test", ready: true }),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ syncPropertyPipelineFromServer: () => Promise.resolve() }));
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: () => null,
  isEntireHomeProperty: () => false,
  parseRoomChoiceValue: (value: string) => ({ listingRoomId: value.includes("::") ? value.split("::")[1] : null }),
  getRoomOptionsForProperty: () => [],
}));
vi.mock("@/lib/channel-calendar/room-date-blocks", () => ({
  ROOM_DATE_BLOCKS_CHANGED: "axis:room-date-blocks-changed",
  fetchRoomDateBlocks: () => Promise.resolve([]),
  saveRoomDateBlock: () => Promise.resolve({ id: "b1" }),
  deleteRoomDateBlock: () => Promise.resolve(),
}));
vi.mock("@/lib/channel-calendar/stay-meta-client", () => ({
  fetchStayMetas: () => Promise.resolve([]),
  saveStayMeta: () => Promise.resolve(),
}));
// The two reads the live portfolio was waiting on. Neither ever answers here.
vi.mock("@/lib/lease-pipeline-storage", () => ({
  LEASE_PIPELINE_EVENT: "lease-pipeline-changed",
  leasePipelineReadSucceeded: () => false,
  leaseIsFullyExecuted: () => false,
  readLeasePipeline: () => [],
  syncLeasePipelineFromServer: () => new Promise(() => {}),
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  normalizeApplicationAxisId: (id: unknown) => String(id ?? ""),
  readManagerApplicationRows: () => [],
  syncManagerApplicationsFromServerWithStatus: () => new Promise(() => {}),
}));

const occupancyFetch = vi.fn<() => Promise<unknown>>();
vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: () => Promise.resolve([]),
  fetchOccupancySnapshot: () => occupancyFetch(),
  fetchWritableChannelCalendarPropertyIds: (ids: string[]) => Promise.resolve(ids),
  fetchChannelCalendarConnections: () => Promise.resolve([]),
  saveManagerChannelCalendarLink: () => Promise.resolve({ ok: true }),
}));

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerBookingsWorkspace } from "@/components/portal/pro-bookings";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { occupancySnapshotForManager } from "@/lib/occupancy/snapshot.server";

const OUT = process.env.EVIDENCE_DIR ?? "";
const log: string[] = [];
const say = (line = "") => log.push(line);

function writeShot(name: string, caption: string, body: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<div style="max-width:1100px;margin:16px auto;padding:0 16px 48px">
<p style="font:600 13px/1.5 system-ui;color:#475569;margin:0 0 12px;white-space:pre-line">${caption}</p>
${body}</div></body></html>`,
  );
}

const OWNER = "owner-1";
const HOUSE = "seattle-homes-1";
const HOUSE_LABEL = "Seattle Homes · 5259 Brooklyn Ave NE";

/** Fifteen residents, one per room — the live workspace's roster. */
const RESIDENTS = [
  "Ambika Rao", "Bennett Cole", "Carla Nguyen", "Darius Pope", "Elena Marsh",
  "Farid Haddad", "Grace Okafor", "Hugo Belmonte", "Imani Sealy", "Jonas Petrov",
  "Keiko Arai", "Luis Ferrer", "Maya Lindqvist", "Noor Rahimi", "Oscar Delgado",
];

function listing() {
  const submission = createDefaultListingSubmission();
  submission.rentalStyle = "rooms";
  submission.rooms = RESIDENTS.map((_, i) => ({
    ...submission.rooms[0]!,
    id: `room-${i + 1}`,
    name: `Room ${i + 1}`,
    occupancyCapacity: 1,
  }));
  return submission;
}

/** One approved, manually added resident row, written by the house's own owner. */
const residentRow = (name: string, i: number) => ({
  id: `AXIS-SEA-${String(i + 1).padStart(2, "0")}`,
  manager_user_id: OWNER,
  property_id: HOUSE,
  assigned_property_id: HOUSE,
  row_data: {
    bucket: "approved",
    manuallyAdded: true,
    name,
    email: `${name.split(" ")[0]!.toLowerCase()}@example.test`,
    assignedPropertyId: HOUSE,
    assignedRoomChoice: `${HOUSE}::room-${i + 1}`,
    manualResidentDetails: {
      moveInDate: "2026-09-01",
      moveOutDate: "2027-08-31",
      monthlyRent: 900 + i * 25,
      securityDeposit: 500,
      leaseTerm: "long_term",
      phone: "+1206555010" + (i % 10),
    },
  },
});

function fakeDb(submission: ReturnType<typeof listing>, applications: unknown[]) {
  return {
    from(table: string) {
      let ownerFilter: string | null = null;
      const query = {
        select() { return this; },
        in() { return this; },
        eq(column: string, value: string) {
          if (column === "manager_user_id") ownerFilter = value;
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
                ? { id: HOUSE, manager_user_id: OWNER, property_data: { buildingName: HOUSE_LABEL, listingSubmission: submission } }
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
              ? [{ id: HOUSE, manager_user_id: OWNER, property_data: { listingSubmission: submission } }].filter(
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

async function realSnapshot() {
  return occupancySnapshotForManager(
    fakeDb(listing(), RESIDENTS.map((name, i) => residentRow(name, i))),
    OWNER,
    { propertyIds: [HOUSE], from: "2026-10-01", to: "2026-10-31" },
  );
}

async function renderBookings() {
  const view = render(
    <AppUiProvider>
      <ManagerBookingsWorkspace
        bucket="inhouse"
        propertyIds={[HOUSE]}
        propertyOptions={[{ id: HOUSE, label: HOUSE_LABEL }]}
        propertyTick={0}
        refreshSignal={0}
      />
    </AppUiProvider>,
  );
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
  }
  return view;
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // "Today" sits inside every stay, so all fifteen land in the In house tab.
  vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
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
    writeFileSync(`${OUT}/bookings-residents-occupancy.txt`, `${log.join("\n")}\n`);
  }
});
beforeEach(() => occupancyFetch.mockReset());
afterEach(() => cleanup());

describe("evidence · Bookings draws every resident from the occupancy snapshot", () => {
  it("BEFORE: a snapshot with no resident payload leaves the list empty while applications hang", async () => {
    const snapshot = await realSnapshot();
    // The snapshot as it was sent before this change: the stays carried no resident facts, so
    // the only way a resident reached the calendar was the ~30s applications read.
    occupancyFetch.mockResolvedValue({
      ...snapshot,
      stays: snapshot.stays.map(({ resident: _drop, ...rest }) => rest),
    });
    const view = await renderBookings();
    const text = view.container.textContent ?? "";

    say("PropLane · Bookings residents from the occupancy snapshot (2026-10-10)");
    say("Real product code: the server's own occupancySnapshotForManager -> the real");
    say("useManagerBookingEntries hook -> the real Bookings list. /api/manager-applications and");
    say("/api/portal-lease-pipeline NEVER answer, the way the live ~30s reads behaved.");
    say();
    say(`Workspace: ${HOUSE_LABEL} — ${RESIDENTS.length} residents on file, one per room.`);
    say();
    say("BEFORE — occupancy stays with no resident payload (residents came from applications only):");
    say(`  resident rows drawn in "In house": ${RESIDENTS.filter((n) => text.includes(n)).length} of ${RESIDENTS.length}`);
    say(`  what the manager reads: ${text.includes("No in-house") || /No .*bookings/i.test(text) ? "the empty state" : text.replace(/\s+/g, " ").slice(0, 120)}`);
    say();

    for (const name of RESIDENTS) expect(text).not.toContain(name);
    writeShot(
      "bookings-residents-before",
      `BEFORE — Manager portal -> Bookings -> In house, ${HOUSE_LABEL}.\nFifteen residents are on file, but the list is empty: the rows were rebuilt from /api/manager-applications, which had not answered.`,
      view.container.innerHTML,
    );
  });

  it("AFTER: every one of the fifteen residents draws as soon as occupancy answers", async () => {
    const snapshot = await realSnapshot();
    expect(snapshot.stays).toHaveLength(RESIDENTS.length);
    occupancyFetch.mockResolvedValue(snapshot);

    const view = await renderBookings();
    const text = view.container.textContent ?? "";

    const drawn = RESIDENTS.filter((name) => text.includes(name));
    say("AFTER — the same snapshot carrying each stay's resident facts:");
    say(`  resident rows drawn in "In house": ${drawn.length} of ${RESIDENTS.length}`);
    say(`  names: ${drawn.join(", ")}`);
    say(`  In-house tab count on screen: ${/In-house\s*(\d+)/.exec(text)?.[1] ?? "(not shown)"}`);
    say(`  "couldn't load" band shown: ${/could ?n.t be loaded|Couldn.t load|Retry/i.test(text) ? "yes" : "no"}`);
    const firstRow = view.container.querySelector('[data-attr="bookings-list-row-application:AXIS-SEA-01"]');
    say(`  one row, end to end: ${(firstRow?.textContent ?? "").replace(/\s+/g, " ").trim()}`);
    say();

    expect(drawn).toHaveLength(RESIDENTS.length);
    expect(view.container.querySelectorAll('[data-attr^="bookings-list-row-"]')).toHaveLength(RESIDENTS.length);
    // The tab count the manager reads has to agree with the rows under it.
    expect(text).toMatch(/In-house\s*15/);
    // The slow reads failing is not a missing-bookings failure once occupancy answered.
    expect(text).not.toMatch(/Retry/i);

    writeShot(
      "bookings-residents-after",
      `AFTER — Manager portal -> Bookings -> In house, ${HOUSE_LABEL}.\nAll fifteen residents draw straight off /api/portal/occupancy, with rent, room and dates — while /api/manager-applications and the lease read are still hanging.`,
      view.container.innerHTML,
    );
  });
});
