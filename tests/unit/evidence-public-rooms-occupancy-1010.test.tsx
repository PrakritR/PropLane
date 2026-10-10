// @vitest-environment jsdom
/**
 * Evidence harness for the ship-to-production security pass (2026-10-10) — the
 * surface a PROSPECT sees.
 *
 * `security-occupancy` proves the API answer; this renders the page that answer
 * feeds. A stranger who runs another house files an approved resident row that
 * names this house's shared room. The public listing's Rooms table must still
 * read "2 of 2 beds open" — the planted row holds no bed — while the same row
 * written by the house's own owner takes one.
 *
 * The occupancy handed to the table is the REAL `loadPublicRoomOccupancy`
 * output for each author, not a hand-written fixture.
 *
 * With EVIDENCE_DIR set it writes the two rendered tables plus a side-by-side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ListingFloorCard, ListingRoomRow } from "@/data/listing-rich-content";

vi.mock("server-only", () => ({}));
vi.mock("@/hooks/use-prospect-contact-autofill", () => ({
  useProspectContactAutofill: () => ({ contact: null, loading: false }),
}));

let OCCUPANCY: { roomChoice: string; spans: { start: string; end: string | null; count: number }[] }[] = [];
vi.mock("@/hooks/use-listing-public-occupancy", () => ({
  useListingPublicOccupancy: () => ({ rooms: OCCUPANCY }),
}));

import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import { SpacesInteractive } from "@/components/marketing/listing-detail-tables-client";

const OUT = process.env.EVIDENCE_DIR ?? "";
const OWNER = "owner-1";
const STRANGER = "stranger-1";
const HOUSE = "victim-house";
const ROOM = "room-a";

function listing() {
  const submission = createDefaultListingSubmission();
  submission.rooms = [{ ...submission.rooms[0]!, id: ROOM, name: "Room A", occupancyCapacity: 2 }];
  return submission;
}

/** One approved, manually added resident row naming HOUSE · Room A. `author` wrote it. */
function plantedRow(author: string) {
  return {
    id: `AXIS-${author}`,
    manager_user_id: author,
    property_id: author === OWNER ? HOUSE : `${author}-house`,
    assigned_property_id: HOUSE,
    assigned: HOUSE,
    choice: `${HOUSE}::${ROOM}`,
    manually_added: "true",
    manual_start: "2026-10-01",
    manual_end: "2026-12-31",
    row_data: {
      bucket: "approved",
      manuallyAdded: true,
      name: "Planted Resident",
      assignedPropertyId: HOUSE,
      assignedRoomChoice: `${HOUSE}::${ROOM}`,
      manualResidentDetails: { moveInDate: "2026-10-01", moveOutDate: "2026-12-31" },
    },
  };
}

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
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        range(start: number) {
          return Promise.resolve({
            data: table === "manager_application_records" ? applications.slice(start) : [],
            error: null,
          });
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

async function occupancyFor(author: string) {
  const submission = listing();
  const rooms = await loadPublicRoomOccupancy(
    fakeDb(submission, [plantedRow(author)]),
    [{ id: HOUSE, listingSubmission: submission }],
    OWNER,
  );
  return rooms as typeof OCCUPANCY;
}

const room = {
  id: ROOM,
  name: "Room A",
  detail: "",
  price: "$900/mo",
  priceMonthlyEquivalent: 900,
  occupancyCapacity: 2,
  availability: "Available now",
  bathroomShareCount: 2,
  modal: { photoUrls: [], bathroomShortLabel: "Shared bath" },
} as unknown as ListingRoomRow;

const floors = [
  { floorLabel: "2nd floor", fromPrice: "$900", roomCount: 1, rooms: [room] },
] as unknown as ListingFloorCard[];

const captured: Record<string, string> = {};

function writeShot(name: string, caption: string, body: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<div class="@container" style="max-width:900px;margin:16px auto;padding:0 16px">
<p style="font:600 13px/1.5 system-ui;color:#475569;margin:0 0 10px;white-space:pre-line">${caption}</p>
${body}</div></body></html>`,
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.setSystemTime(new Date("2026-10-10T12:00:00"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("evidence · the public listing's Rooms table ignores a stranger's planted row", () => {
  it("still shows both beds open, and takes one for the owner's own row", async () => {
    for (const author of [STRANGER, OWNER]) {
      OCCUPANCY = await occupancyFor(author);
      const { container, unmount } = render(
        <SpacesInteractive floorPlans={floors} bathrooms={[]} sharedSpaces={[]} listingPropertyId={HOUSE} />,
      );
      captured[author] = (container.querySelector("table") as HTMLElement).textContent ?? "";
      captured[`${author}:html`] = container.querySelector("[data-sr-rooms]")?.outerHTML ?? "";
      unmount();
    }

    expect(captured[STRANGER]).toContain("2 of 2 beds open");
    expect(captured[OWNER]).toContain("1 of 2 beds open");

    writeShot(
      "public-rooms-stranger-planted",
      "The house's public listing · Rooms.\nstranger-1 (who runs a different house) filed an approved resident row naming this room.\nThe room is untouched: 2 of 2 beds open.",
      captured[`${STRANGER}:html`] ?? "",
    );
    writeShot(
      "public-rooms-owner-row",
      "The same room after the house's OWN owner files that resident row.\nOne bed is taken: 1 of 2 beds open.",
      captured[`${OWNER}:html`] ?? "",
    );
    writeShot(
      "public-rooms-side-by-side",
      "Same room, same planted resident row — the only difference is who wrote it.",
      `<section><p style="font:700 13px/1.4 system-ui;color:#0f172a;margin:0 0 8px">Row written by a stranger who runs another house</p>${captured[`${STRANGER}:html`] ?? ""}</section>
<section style="margin-top:24px"><p style="font:700 13px/1.4 system-ui;color:#0f172a;margin:0 0 8px">The same row written by the house's own owner</p>${captured[`${OWNER}:html`] ?? ""}</section>`,
    );
  });
});
