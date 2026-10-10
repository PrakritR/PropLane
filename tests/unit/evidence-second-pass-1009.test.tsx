// @vitest-environment jsdom
/**
 * Evidence harness for the captain-approved second pass (2026-10-09).
 *
 * Renders the real screens the change is about and, when EVIDENCE_DIR is set,
 * dumps the markup for screenshotting (same convention as
 * `evidence-bookings-calendar.test.tsx`):
 *
 *   1. Bookings list — a manually added resident carries rent, deposit and
 *      contact; an Airbnb stay reads the manager-entered guest name, else
 *      "Airbnb guest · HM…", with the phone ending as a plain fact.
 *   2. Airbnb's "Not available" echo of a PropLane resident on the same room
 *      is dropped, so the room no longer reads as double-booked.
 *   3. The booking record's Guest tab — name (editable), reservation code with
 *      Open in Airbnb, phone ending.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";

vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/rental-application/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/data")>()),
  // The room listing says $900 for Room 2; the resident pays their own $1,100.
  getPropertyById: () => ({
    listingSubmission: { rooms: [{ id: "r2", name: "Room 2", monthlyRent: 900, rentBasis: "monthly" }] },
  }),
}));

import { applicationHoldEntries, airbnbBookingEntries, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { withoutEchoedHostBlocks } from "@/lib/channel-calendar/host-block";
import { holdRowFromApplication } from "@/lib/occupancy/snapshot.server";
import { ManagerBookingsListView } from "@/components/portal/manager-bookings-list-view";
import { BookingsRecordPage } from "@/components/portal/bookings-record-page";
import { bookingEntryKey } from "@/lib/channel-calendar/bookings-ui";

const OUT = process.env.EVIDENCE_DIR ?? "";

function writeShot(name: string, caption: string, body: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<div style="max-width:1100px;margin:16px auto;padding:0 16px">
<p style="font:600 13px/1.5 system-ui;color:#475569;margin:0 0 10px;white-space:pre-line">${caption}</p>
${body}</div></body></html>`,
  );
}

const PROPERTY = { id: "p1", label: "5259 Brooklyn Ave" };

const residentRow = {
  id: "AXIS-MAN1",
  property_id: "p1",
  assigned_property_id: "p1",
  row_data: {
    bucket: "approved",
    name: "Manual Mo",
    email: "mo@example.test",
    manuallyAdded: true,
    signedMonthlyRent: 1100,
    assignedRoomChoice: "p1::r2",
    manualResidentDetails: {
      moveInDate: "2026-09-24",
      moveOutDate: "2026-12-31",
      phone: "+12065550100",
      securityDeposit: 500,
      leaseTerm: "3 months",
    },
  },
};

function holdEntry(): PropertyBookingEntry {
  return applicationHoldEntries([holdRowFromApplication(residentRow)], {
    properties: [PROPERTY],
    roomLabelForId: (_p, r) => (r === "r2" ? "Room 2" : "Room"),
    isLeased: () => false,
    openEndedHorizonKey: "2028-10-09",
  })[0]!;
}

/** Two Airbnb stays off the same linked room feed: one named by the manager, one not. */
function airbnbEntries(): PropertyBookingEntry[] {
  return airbnbBookingEntries([
    {
      propertyId: "p1",
      propertyLabel: PROPERTY.label,
      rooms: [
        {
          connectionId: "conn-1",
          roomId: "r3",
          roomLabel: "Room 3",
          provider: "airbnb",
          label: "Airbnb · Room 3",
          lastSyncedAt: "2026-10-09T18:00:00.000Z",
          lastError: null,
          ranges: [
            {
              id: "uid-1",
              sourceUid: "uid-1",
              summary: "Reserved",
              start: "2026-10-12",
              end: "2026-10-16",
              reservationCode: "HMABCDEFGH",
              reservationUrl: "https://www.airbnb.com/hosting/reservations/details/HMABCDEFGH",
              phoneLast4: "1234",
              guestName: "Maria Lopez",
            },
            {
              id: "uid-2",
              sourceUid: "uid-2",
              summary: "Reserved",
              start: "2026-10-20",
              end: "2026-10-23",
              reservationCode: "HMZZ99AA11",
              reservationUrl: "https://www.airbnb.com/hosting/reservations/details/HMZZ99AA11",
              phoneLast4: "7788",
            },
          ],
        },
      ],
    },
  ] as never);
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T12:00:00.000Z"));
});
afterAll(() => vi.useRealTimers());
afterEach(() => cleanup());

function listOf(entries: PropertyBookingEntry[]) {
  return (
    <ManagerBookingsListView
      entries={entries}
      bucket="upcoming"
      selectedKeys={new Set()}
      onToggleSelected={() => {}}
    />
  );
}

describe("evidence · Bookings carries every stay's own facts", () => {
  it("a resident row says rent, deposit and contact; an Airbnb row says who booked", async () => {
    const entries = [holdEntry(), ...airbnbEntries()];
    const view = render(listOf(entries));
    await act(async () => { await Promise.resolve(); });
    const text = view.container.textContent ?? "";
    expect(text).toContain("Manual Mo");
    expect(text).toContain("$1,100/mo");
    expect(text).toContain("Maria Lopez");
    expect(text).toContain("Airbnb guest · HMZZ99AA11");
    expect(text).toContain("Phone ending 1234");
    expect(text).toContain("Phone ending 7788");
    writeShot(
      "bookings-list-facts",
      "House → Bookings → Upcoming. The manually added resident carries their OWN rent ($1,100/mo, not the room's $900 listing rate) with their dates and room; each Airbnb stay reads the manager-entered guest name when there is one, else &quot;Airbnb guest&quot; and the reservation code, with the phone's last four digits as a plain fact.",
      view.container.innerHTML,
    );
  });

  it("drops Airbnb's 'Not available' echo of a PropLane resident on the same room", async () => {
    const resident = holdEntry();
    const echo = airbnbBookingEntries([
      {
        propertyId: "p1",
        propertyLabel: PROPERTY.label,
        rooms: [
          {
            connectionId: "conn-1",
            roomId: "r2",
            roomLabel: "Room 2",
            provider: "airbnb",
            label: "Airbnb · Room 2",
            lastSyncedAt: "2026-10-09T18:00:00.000Z",
            lastError: null,
            ranges: [{ id: "uid-echo", sourceUid: "uid-echo", summary: "Airbnb (Not available)", start: "2026-10-01", end: "2026-12-31" }],
          },
        ],
      },
    ] as never);
    const raw = [resident, ...echo];
    const kept = withoutEchoedHostBlocks(raw);
    expect(raw).toHaveLength(2);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.source).toBe("hold");

    const before = render(listOf(raw as PropertyBookingEntry[]));
    await act(async () => { await Promise.resolve(); });
    const beforeHtml = before.container.innerHTML;
    cleanup();
    const after = render(listOf(kept as PropertyBookingEntry[]));
    await act(async () => { await Promise.resolve(); });
    expect(after.container.textContent).not.toContain("Airbnb block");

    writeShot(
      "bookings-no-fake-overlap",
      "Room 2 is let through PropLane, and Airbnb echoes that back as its own 'Not available' range on the same room.\nBefore (what the feed sends) the room reads as double-booked; after, only the real PropLane stay is drawn.",
      `<p style="font:600 12px system-ui;color:#b42318;margin:14px 0 6px">Before — the echo drawn as a second stay</p>${beforeHtml}
<p style="font:600 12px system-ui;color:#067647;margin:22px 0 6px">After — the echo dropped, the real stay kept</p>${after.container.innerHTML}`,
    );
  });
});

describe("evidence · the resident's booking record carries their facts", () => {
  it("Overview says rent, deposit and lease term; Guest says the contact", async () => {
    const entries = [holdEntry()];
    const entry = entries[0]!;
    const page = (tab: string) => (
      <BookingsRecordPage
        bookingId={bookingEntryKey(entry)}
        tab={tab}
        basePath="/portal"
        entries={entries}
        loading={false}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onRemoveBlock={async () => {}}
        showToast={() => {}}
      />
    );
    const overview = render(page("overview"));
    await act(async () => { await Promise.resolve(); });
    const facts = document.querySelector('[data-attr="booking-overview-facts"]')!;
    expect(facts.textContent).toContain("$1,100/mo");
    expect(facts.textContent).toContain("$500");
    expect(facts.textContent).toContain("3 months");
    const overviewHtml = overview.container.innerHTML;
    cleanup();
    const guest = render(page("guest"));
    await act(async () => { await Promise.resolve(); });
    const card = document.querySelector('[data-attr="booking-guest-card"]')!;
    expect(card.textContent).toContain("mo@example.test");
    expect(card.textContent).toContain("+12065550100");
    writeShot(
      "bookings-record-resident",
      "Bookings → the manually added resident → Overview and Guest. The stay carries the resident's own rent, deposit and lease term, and their email and phone — the facts that used to be missing for anyone who was not a signed-lease resident.",
      `<p style="font:600 12px system-ui;color:#475569;margin:14px 0 6px">Overview</p>${overviewHtml}
<p style="font:600 12px system-ui;color:#475569;margin:22px 0 6px">Guest</p>${guest.container.innerHTML}`,
    );
  });
});

describe("evidence · the booking record names the Airbnb guest", () => {
  it("Guest tab shows the name, the reservation code with Open in Airbnb, and the phone ending", async () => {
    const entries = airbnbEntries();
    const entry = entries[0]!;
    const view = render(
      <BookingsRecordPage
        bookingId={bookingEntryKey(entry)}
        tab="guest"
        basePath="/portal"
        entries={entries}
        loading={false}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onRemoveBlock={async () => {}}
        showToast={() => {}}
      />,
    );
    await act(async () => { await Promise.resolve(); });
    const card = document.querySelector('[data-attr="booking-guest-card"]')!;
    expect(card.textContent).toContain("Maria Lopez");
    expect(card.textContent).toContain("HMABCDEFGH");
    expect(card.textContent).toContain("1234");
    expect(document.querySelector('[data-attr="booking-open-in-airbnb"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="booking-guest-name-edit"]')).toBeTruthy();
    writeShot(
      "bookings-record-guest",
      "Bookings → the Airbnb stay → Guest. The manager-entered name sits next to a pencil that re-opens the name dialog; the reservation code carries an Open in Airbnb action, and the phone's last four digits are shown — the only contact Airbnb discloses.",
      view.container.innerHTML,
    );
  });
});
