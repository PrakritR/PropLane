// @vitest-environment jsdom
/**
 * Evidence harness for the ship-to-production security pass (2026-10-10) — the
 * occupancy and Bookings half.
 *
 * Everything here is the product's own code against a fake database; the lines
 * written out are what the real functions returned, not a restatement of them.
 *
 *   1. A house's room is held only by a row its OWN people wrote — the owner or
 *      a teammate the owner linked to that house. A stranger's planted row, and
 *      a property-owner (investor) link, hold nothing.
 *   2. Resident money (rent, deposit, term, phone) is dropped from the Bookings
 *      snapshot for a teammate who only has Calendar, and kept for the owner and
 *      for a teammate with Residents view.
 *
 * With EVIDENCE_DIR set it writes `security-occupancy.txt` plus the two rendered
 * Bookings rows (`bookings-financials-*.html`) for screenshotting.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/rental-application/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/data")>()),
  getPropertyById: () => null,
}));

import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import {
  applicationHoldEntries,
  withoutResidentFinancials,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import { holdRowFromApplication, occupancyHoldEntries, occupancySnapshotForManager } from "@/lib/occupancy/snapshot.server";
import { ManagerBookingsListView } from "@/components/portal/manager-bookings-list-view";

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
<div style="max-width:1100px;margin:16px auto;padding:0 16px">
<p style="font:600 13px/1.5 system-ui;color:#475569;margin:0 0 10px;white-space:pre-line">${caption}</p>
${body}</div></body></html>`,
  );
}

const OWNER = "owner-1";
const LINKED = "co-manager-1";
const STRANGER = "stranger-1";
const INVESTOR = "investor-1";
const HOUSE = "victim-house";

function listing() {
  const submission = createDefaultListingSubmission();
  submission.rooms = [{ ...submission.rooms[0]!, id: "room-a", name: "Room A", occupancyCapacity: 1 }];
  return submission;
}

/** An approved, manually added resident row. `author` is who wrote it. */
function plantedRow(id: string, author: string) {
  return {
    id,
    manager_user_id: author,
    // Filed under the author's own house, but pointing the room at the victim's.
    property_id: author === OWNER || author === LINKED ? HOUSE : `${author}-house`,
    assigned_property_id: HOUSE,
    // The public read selects these aliases off the same row.
    assigned: HOUSE,
    choice: `${HOUSE}::room-a`,
    manually_added: "true",
    manual_start: "2026-10-01",
    manual_end: "2026-12-31",
    row_data: {
      bucket: "approved",
      manuallyAdded: true,
      name: "Planted Resident",
      assignedPropertyId: HOUSE,
      assignedRoomChoice: `${HOUSE}::room-a`,
      manualResidentDetails: { moveInDate: "2026-10-01", moveOutDate: "2026-12-31" },
    },
  };
}

function fakeDb(submission: ReturnType<typeof listing>, applications: unknown[], links?: unknown[]) {
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
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        range(start: number) {
          return Promise.resolve({ data: table === "manager_application_records" ? applications.slice(start) : [], error: null });
        },
        then(resolve: (value: unknown) => unknown) {
          const data =
            table === "manager_property_records"
              ? [{ id: HOUSE, manager_user_id: OWNER, property_data: { listingSubmission: submission } }].filter(
                  (row) => !ownerFilter || row.manager_user_id === ownerFilter,
                )
              : table === "account_link_invites"
                ? (links ?? [
                    { inviter_user_id: OWNER, invitee_user_id: LINKED, assigned_property_ids: [HOUSE], team_role: "leasing", status: "accepted" },
                    { inviter_user_id: OWNER, invitee_user_id: INVESTOR, assigned_property_ids: [HOUSE], team_role: "property_owner", status: "accepted" },
                  ])
                : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
  } as never;
}

async function publicSpans(author: string) {
  const submission = listing();
  const rooms = await loadPublicRoomOccupancy(
    fakeDb(submission, [plantedRow(`AXIS-${author}`, author)]),
    [{ id: HOUSE, listingSubmission: submission }],
    OWNER,
  );
  return rooms.find((room) => room.roomChoice === `${HOUSE}::room-a`)?.spans ?? [];
}

async function bookingHolds(author: string) {
  const submission = listing();
  return occupancyHoldEntries(fakeDb(submission, [plantedRow(`AXIS-${author}`, author)]), [HOUSE], [], {
    properties: [{ id: HOUSE, label: "5259 Brooklyn Ave", entireHomeListing: false }],
    roomLabelForId: () => "Room A",
  });
}

describe("evidence · a house's room is held only by rows its own people wrote", () => {
  it("drops a stranger's and an investor link's planted rows from both the public page and Bookings", async () => {
    say("PropLane · security evidence · occupancy and Bookings (2026-10-10)");
    say("Real product code against a fake database. Every line below is what the function returned.");
    say();
    say("1. A room is held only by a row the house's OWN people wrote");
    say(`   House ${HOUSE} · Room A · owner ${OWNER} · ${LINKED} is a linked teammate · ${INVESTOR} holds a property-owner link`);
    say(`   The attack: ${STRANGER} manages a different house and files an approved resident row that NAMES ${HOUSE} · Room A.`);
    say();
    say("   Public room availability — what a prospect's browser reads:");
    const publicResults: Array<[string, string]> = [];
    for (const [author, who] of [
      [STRANGER, "stranger-1 (runs another house)"],
      [OWNER, "owner-1 (the house's owner)"],
      [LINKED, "co-manager-1 (teammate linked to this house)"],
      [INVESTOR, "investor-1 (property-owner link)"],
    ] as const) {
      const spans = await publicSpans(author);
      const text = spans.length === 0 ? "[] — room stays bookable" : spans.map((s) => `${s.start} → ${s.end}`).join(", ");
      publicResults.push([author, text]);
      say(`     row written by ${who.padEnd(38)} -> ${text}`);
    }
    expect(publicResults.find(([a]) => a === STRANGER)?.[1]).toContain("room stays bookable");
    expect(publicResults.find(([a]) => a === INVESTOR)?.[1]).toContain("room stays bookable");
    expect(publicResults.find(([a]) => a === OWNER)?.[1]).toContain("2026-10-01");
    expect(publicResults.find(([a]) => a === LINKED)?.[1]).toContain("2026-10-01");

    say();
    say("   Manager Bookings holds — the calendar's own read of the same rows:");
    for (const [author, who] of [
      [STRANGER, "stranger-1"],
      [OWNER, "owner-1"],
      [LINKED, "co-manager-1"],
      [INVESTOR, "investor-1"],
    ] as const) {
      const holds = await bookingHolds(author);
      const ids = holds.map((entry) => entry.applicationId);
      say(`     row written by ${who.padEnd(38)} -> ${ids.length ? ids.join(", ") : "(no hold — room free)"}`);
      expect(ids.length).toBe(author === OWNER || author === LINKED ? 1 : 0);
    }
    say();
  });
});

describe("evidence · resident money is hidden from a calendar-only teammate", () => {
  const HOLD = {
    id: "AXIS-RENT",
    manager_user_id: OWNER,
    property_id: HOUSE,
    assigned_property_id: HOUSE,
    row_data: {
      bucket: "approved",
      manuallyAdded: true,
      name: "Rita Resident",
      assignedRoomChoice: `${HOUSE}::room-a`,
      manualResidentDetails: {
        moveInDate: "2026-10-01",
        moveOutDate: "2026-12-31",
        monthlyRent: 1450,
        securityDeposit: 900,
        leaseTerm: "long_term",
        phone: "+12065550123",
      },
    },
  };

  const calendarOnly = [{
    inviter_user_id: OWNER, invitee_user_id: LINKED, assigned_property_ids: [HOUSE], team_role: "custom", status: "accepted",
    property_co_manager_permissions: { [HOUSE]: { calendar: { read: true } } },
  }];
  const withResidents = [{
    ...calendarOnly[0]!,
    property_co_manager_permissions: { [HOUSE]: { calendar: { read: true }, residents: { read: true } } },
  }];

  async function stays(viewer: string, links: unknown[]) {
    const snapshot = await occupancySnapshotForManager(fakeDb(listing(), [HOLD], links), viewer, {
      propertyIds: [HOUSE],
      from: "2026-10-01",
      to: "2026-10-31",
    });
    return snapshot.stays;
  }

  it("the Bookings snapshot carries rent for the owner and for Residents view, and not for Calendar-only", async () => {
    say("2. Resident money in the Bookings snapshot, by what the viewer is allowed to see");
    say(`   One stay: Rita Resident, ${HOUSE} · Room A, Oct 1 – Dec 31, $1,450/mo.`);
    const rows: Array<[string, unknown]> = [
      ["owner-1 (owns the house)", (await stays(OWNER, []))[0]],
      ["co-manager-1 — Calendar: read only", (await stays(LINKED, calendarOnly))[0]],
      ["co-manager-1 — Calendar + Residents: read", (await stays(LINKED, withResidents))[0]],
    ];
    for (const [who, stay] of rows) {
      const s = stay as { name?: string; start?: string; end?: string; monthlyRent?: number } | undefined;
      const money = s && "monthlyRent" in s ? `monthlyRent ${s.monthlyRent}` : "monthlyRent ABSENT";
      say(`     ${who.padEnd(42)} -> stay "${s?.name}" ${s?.start}…${s?.end} · ${money}`);
    }
    expect((rows[0]![1] as { monthlyRent?: number }).monthlyRent).toBe(1450);
    expect(rows[1]![1]).not.toHaveProperty("monthlyRent");
    expect((rows[2]![1] as { monthlyRent?: number }).monthlyRent).toBe(1450);
    say();
  });

  it("renders the Bookings row each viewer actually sees", async () => {
    const ownerEntry = applicationHoldEntries([holdRowFromApplication(HOLD)], {
      properties: [{ id: HOUSE, label: "5259 Brooklyn Ave" }],
      roomLabelForId: () => "Room A",
      isLeased: () => false,
      openEndedHorizonKey: "2028-10-09",
    })[0]! as PropertyBookingEntry;
    // The exact transform `occupancySnapshotForManager` applies to a house the viewer
    // may see on the calendar but has no Residents access to.
    const teammateEntry = withoutResidentFinancials(ownerEntry);

    expect(ownerEntry.monthlyRent).toBe(1450);
    expect(teammateEntry.monthlyRent).toBeUndefined();
    expect(teammateEntry.residentPhone).toBeUndefined();
    expect(teammateEntry.securityDeposit).toBeUndefined();
    expect(teammateEntry.leaseTerm).toBeUndefined();

    const view = (entry: PropertyBookingEntry) => (
      <ManagerBookingsListView entries={[entry]} bucket="upcoming" selectedKeys={new Set()} onToggleSelected={() => {}} />
    );

    const ownerRender = render(view(ownerEntry));
    const ownerText = ownerRender.container.textContent ?? "";
    expect(ownerText).toContain("$1,450/mo");
    writeShot(
      "bookings-financials-owner",
      "House → Bookings → Upcoming, as the OWNER (or a teammate with Residents view).\nThe resident's own rent is on the row.",
      ownerRender.container.innerHTML,
    );
    ownerRender.unmount();

    const mateRender = render(view(teammateEntry));
    const mateText = mateRender.container.textContent ?? "";
    expect(mateText).toContain("Rita Resident");
    expect(mateText).not.toContain("1,450");
    expect(mateText).not.toContain("0123");
    writeShot(
      "bookings-financials-calendar-only",
      "The same stay as a teammate with Calendar access but NOT Residents.\nThe room still reads as taken, by name and dates — the rent, deposit, term and phone are gone.",
      mateRender.container.innerHTML,
    );
    mateRender.unmount();

    say("3. The same Bookings row, rendered for each viewer (screenshots alongside this file)");
    say(`     owner / Residents view  -> ${ownerText.replace(/\s+/g, " ").trim()}`);
    say(`     Calendar-only teammate  -> ${mateText.replace(/\s+/g, " ").trim()}`);
    say();

    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(`${OUT}/security-occupancy.txt`, `${log.join("\n")}\n`);
    }
  });
});
