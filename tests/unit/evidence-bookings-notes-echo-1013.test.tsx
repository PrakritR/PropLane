// @vitest-environment jsdom
/**
 * Evidence harness (batch 2, 2026-10-13), two deliberate behaviours on the
 * manager's Bookings surface:
 *
 * 1. Airbnb echo suppression WITH a remainder. Room A is let through PropLane
 *    Aug 4-12, and the linked Airbnb calendar hands back its own "Not
 *    available" range for Aug 1-20 - PropLane's own export reflected back. The
 *    covered nights are dropped; the two uncovered pieces (Aug 1-3, Aug 13-20)
 *    stay drawn, because the manager really did close those nights on Airbnb.
 *    Room B's real reservation is untouched. "Before" renders the same screen
 *    with the filter bypassed, so the reviewer sees what the raw feed drew.
 *
 * 2. Notes. A channel stay's note is a plain Notes row on the booking record and
 *    a multi-line field in the one "Booking details" popup; a host block's Edit
 *    opens the same popup titled "Block notes" with nothing but Notes.
 *
 * Screenshot-ready HTML is written only when EVIDENCE_DIR is set.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { renderedBodyHtml } from "../helpers/evidence-dom";

const state = vi.hoisted(() => ({ bypassEcho: false }));

vi.mock("@/lib/channel-calendar/host-block", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/channel-calendar/host-block")>();
  return {
    ...actual,
    // "Before" = the screen as it was, drawing every imported range.
    withoutEchoedHostBlocks: (entries: readonly never[]) =>
      state.bypassEcho ? [...entries] : actual.withoutEchoedHostBlocks(entries),
  };
});
vi.mock("@/lib/lease-pipeline-storage", () => ({
  LEASE_PIPELINE_EVENT: "lease-pipeline-changed",
  leasePipelineReadSucceeded: () => true,
  readLeasePipeline: () => LEASES,
  syncLeasePipelineFromServer: () => Promise.resolve(LEASES),
  leaseIsFullyExecuted: () => true,
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ blocks: [], rows: [], stayDetails: [], guestNames: [] }) }));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  normalizeApplicationAxisId: (id: unknown) => String(id ?? ""),
  readManagerApplicationRows: () => [{ email: "cv.ponce@example.test", bucket: "current" }],
  syncManagerApplicationsFromServerWithStatus: () =>
    Promise.resolve({ rows: [{ email: "cv.ponce@example.test", bucket: "current" }], ok: true }),
}));
vi.mock("@/lib/channel-calendar/client", () => ({
  fetchWritableChannelCalendarPropertyIds: (ids: string[]) => Promise.resolve(ids),
  fetchManagerChannelBookings: () =>
    Promise.resolve([
      {
        propertyId: "mgr-house-1",
        propertyLabel: "4709A 8th Ave NE",
        rooms: [
          {
            connectionId: "conn-a",
            roomId: "room-a",
            roomLabel: "Room A",
            provider: "airbnb",
            label: "Airbnb · Room A",
            // Airbnb reflecting PropLane's own export back, wider than the stay.
            ranges: [{ sourceUid: "echo-1", start: "2026-08-01", end: "2026-08-20", summary: "Airbnb (Not available)" }],
            lastSyncedAt: "2026-08-10T18:00:00.000Z",
            lastError: null,
            hasImportUrl: true,
          },
          {
            connectionId: "conn-b",
            roomId: "room-b",
            roomLabel: "Room B",
            provider: "airbnb",
            label: "Airbnb · Room B",
            ranges: [{ sourceUid: "res-1", start: "2026-08-18", end: "2026-08-22", summary: "Reserved", reservationCode: "HMABCDEFGH", phoneLast4: "1234", guestName: "Maria Lopez" }],
            lastSyncedAt: "2026-08-10T18:00:00.000Z",
            lastError: null,
            hasImportUrl: true,
          },
        ],
      },
    ]),
  fetchChannelCalendarConnections: () => Promise.resolve([]),
  fetchOccupancySnapshot: () => Promise.resolve({ days: [] }),
  saveManagerChannelCalendarLink: () => Promise.resolve({ ok: true }),
  saveChannelStayDetailsClient: (input: unknown) => {
    saved.push(input);
    return Promise.resolve({ ok: true });
  },
  removeChannelStay: (ref: unknown) => {
    removed.push(ref);
    return Promise.resolve({ ok: true });
  },
  restoreChannelStay: () => Promise.resolve({ ok: true }),
}));

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerPropertyBookingsPanel } from "@/components/portal/pro-property-bookings-panel";
import { BookingsRecordPage } from "@/components/portal/bookings-record-page";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { bookingEntryKey } from "@/lib/channel-calendar/bookings-ui";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

const saved: unknown[] = [];
const removed: unknown[] = [];

const LEASES = [
  {
    id: "lease-1",
    propertyId: "mgr-house-1",
    residentName: "Cv Ponce",
    residentEmail: "cv.ponce@example.test",
    roomChoice: "mgr-house-1::room-a",
    stageLabel: "Signed",
    status: "Fully Signed",
    fullySignedAt: "2026-08-01T12:00:00.000Z",
    application: { leaseStart: "2026-08-04", leaseEnd: "2026-08-12" },
  },
] as never[];

const submission = (() => {
  const sub = createDefaultListingSubmission();
  return {
    ...sub,
    rentalStyle: "rooms",
    rooms: [
      { ...(sub.rooms[0] ?? {}), id: "room-a", name: "Room A" },
      { ...(sub.rooms[0] ?? {}), id: "room-b", name: "Room B" },
    ],
  } as typeof sub;
})();

const OUT = process.env.EVIDENCE_DIR ?? "";
function page(name: string, caption: string, body: string, width = 1100) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<div style="max-width:${width}px;margin:16px auto;padding:0 16px 48px">
<p style="font:600 13px/1.6 system-ui;color:#475569;margin:0 0 12px;white-space:pre-line">${caption}</p>
${body}</div></body></html>`,
    "utf8",
  );
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const renderPanel = async () => {
  const view = render(
    <AppUiProvider>
      <ManagerPropertyBookingsPanel propertyId="mgr-house-1" propertyLabel="4709A 8th Ave NE" submission={submission} managerUserId="mgr-1" showToast={() => {}} />
    </AppUiProvider>,
  );
  await settle();
  return view;
};

const barLabels = () =>
  [...document.querySelectorAll('[data-attr="bookings-calendar-bar"]')].map(
    (bar) => `${bar.getAttribute("aria-label") ?? ""} ${bar.textContent ?? ""}`,
  );

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
});
afterAll(() => vi.useRealTimers());
afterEach(() => {
  cleanup();
  saved.length = 0;
  removed.length = 0;
});

describe("evidence · the Airbnb echo is hidden, its uncovered remainder is not", () => {
  it("draws the raw feed before, and only the real stay plus the two remainders after", async () => {
    state.bypassEcho = true;
    const before = await renderPanel();
    const beforeLabels = barLabels();
    // The raw feed draws the host block on top of the PropLane resident.
    expect(beforeLabels.filter((label) => label.includes("Not available"))).toHaveLength(1);
    const beforeHtml = before.container.innerHTML;
    cleanup();

    state.bypassEcho = false;
    const after = await renderPanel();
    const afterLabels = barLabels();
    expect(afterLabels.filter((label) => label.includes("Cv Ponce"))).toHaveLength(1);
    // Two uncovered pieces survive: Aug 1-3 before the stay and Aug 13-20 after it.
    expect(afterLabels.filter((label) => label.includes("Not available"))).toHaveLength(2);
    expect(afterLabels.some((label) => label.includes("Maria Lopez"))).toBe(true);

    page(
      "bookings-echo-remainder",
      "House → Bookings → Calendar, August 2026. Room A is let through PropLane (Cv Ponce, Aug 4–12) and the linked Airbnb calendar hands back its OWN \"Not available\" range for Aug 1–20 — PropLane's export reflected back.\nBefore: the echo is drawn across the resident and the room reads as double-booked.\nAfter: the covered nights are gone and only the uncovered remainder stays — Aug 1–3 and Aug 13–20, nights the manager really did close on Airbnb. Room B's real reservation (Maria Lopez) is untouched.",
      `<p style="font:600 12px system-ui;color:#b42318;margin:14px 0 6px">Before — the echo drawn over the resident</p>${beforeHtml}
<p style="font:600 12px system-ui;color:#067647;margin:26px 0 6px">After — echo hidden, uncovered remainder kept</p>${after.container.innerHTML}`,
    );
  });
});

describe("evidence · notes on a stay and on a host block", () => {
  const record = (entry: PropertyBookingEntry, tab?: string) =>
    render(
      <AppUiProvider>
        <BookingsRecordPage bookingId={bookingEntryKey(entry)} tab={tab} basePath="/portal" entries={[entry]} loading={false} residentOptions={[]} onSaveBlock={async () => {}} onRemoveBlock={async () => {}} showToast={() => {}} />
      </AppUiProvider>,
    );

  const stay: PropertyBookingEntry = {
    source: "airbnb",
    propertyId: "mgr-house-1",
    propertyLabel: "4709A 8th Ave NE",
    roomId: "room-b",
    roomLabel: "Room B",
    summary: "Maria Lopez",
    start: "2026-08-18",
    end: "2026-08-22",
    statusLabel: "Confirmed",
    sourceUid: "res-1",
    connectionId: "conn-b",
    guestName: "Maria Lopez",
    stayNotes: "Arriving on the late flight, lockbox code sent by text.\nLeaving the car in the driveway.",
  };

  const hostBlock: PropertyBookingEntry = {
    source: "airbnb",
    propertyId: "mgr-house-1",
    propertyLabel: "4709A 8th Ave NE",
    roomId: "room-a",
    roomLabel: "Room A",
    summary: "Airbnb (Not available)",
    start: "2026-08-13",
    end: "2026-08-20",
    statusLabel: "Airbnb",
    sourceUid: "echo-1",
    connectionId: "conn-a",
    channelRangeStart: "2026-08-01",
    channelRangeEnd: "2026-08-20",
  };

  it("the note is a plain Notes row on the booking record", async () => {
    record(stay);
    await settle();
    expect(screen.getByText("Notes")).toBeTruthy();
    expect(screen.getByText(/late flight/)).toBeTruthy();
    page(
      "booking-record-notes-row",
      "House → Bookings → a channel stay's record. The manager's note is a plain multi-line Notes row among the other facts — no pill, no subtext.",
      renderedBodyHtml(),
      960,
    );
  });

  it("Booking details keeps one Save, now with multi-line Notes", async () => {
    record(stay, "guest");
    await settle();
    // A channel stay stays read-only: the popup opens from the pencil beside the guest's name.
    fireEvent.click(document.querySelector('[data-attr="booking-guest-name-edit"]')!);
    const notes = document.querySelector('[data-attr="booking-stay-notes-input"]') as HTMLTextAreaElement;
    expect(notes.tagName).toBe("TEXTAREA");
    expect(notes.value).toContain("late flight");
    expect(document.querySelector('[data-attr="booking-stay-name-input"]')).toBeTruthy();
    page(
      "booking-details-notes",
      "The one Booking details popup for a channel stay: the money fields the feed never sends, plus multi-line Notes, behind the same single Save.",
      renderedBodyHtml(),
      860,
    );
  });

  it("a host block's Edit opens 'Block notes' with only Notes, and saves the note", async () => {
    record(hostBlock);
    await settle();
    fireEvent.click(document.querySelector('[data-attr="record-header-action-edit"]')!);
    expect(screen.getByText("Block notes")).toBeTruthy();
    expect(document.querySelector('[data-attr="booking-stay-name-input"]')).toBeNull();
    expect(document.querySelector('[data-attr="booking-stay-payout-input"]')).toBeNull();
    const notes = document.querySelector('[data-attr="booking-stay-notes-input"]') as HTMLTextAreaElement;
    fireEvent.change(notes, { target: { value: "Closed for the owner's own stay." } });
    page(
      "host-block-notes-dialog",
      "House → Bookings → a host block's record → Edit. The same popup, titled \"Block notes\", with nothing but Notes: a block has no guest and no money. One Save.",
      renderedBodyHtml(),
      860,
    );
    await act(async () => {
      fireEvent.click(document.querySelector('[data-attr="booking-stay-details-save"]')!);
      await Promise.resolve();
    });
    expect(saved).toEqual([{ connectionId: "conn-a", sourceUid: "echo-1", notes: "Closed for the owner's own stay." }]);
  });

  it("Remove stay keys a trimmed remainder on the RAW imported range", async () => {
    const { BookingsRemoveStayDialog } = await import("@/components/portal/bookings-remove-stay-dialog");
    render(
      <AppUiProvider>
        <BookingsRemoveStayDialog entry={hostBlock} onClose={() => {}} onChanged={() => {}} />
      </AppUiProvider>,
    );
    await settle();
    page(
      "host-block-remove-remainder",
      "The remainder of an echoed block, Aug 13–20, is still removable: the popup shows the visible dates, but the request it sends identifies the block by its UID plus the RAW imported range (Aug 1–20) — the only dates the server has stored.",
      renderedBodyHtml(),
      860,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove stay" }));
      await Promise.resolve();
    });
    expect(removed).toEqual([{ connectionId: "conn-a", sourceUid: "echo-1", start: "2026-08-01", end: "2026-08-20" }]);
  });
});
