// @vitest-environment jsdom
/**
 * Evidence harness: the Bookings calendar no longer draws Airbnb's echo of a
 * PropLane stay as a second, overlapping bar.
 *
 * The fixture is the case that read as an overbooked room: Room A is let
 * through PropLane Aug 4–12, and the linked Airbnb calendar sends back its own
 * "Not available" range for the same room and dates. Room B carries a REAL
 * Airbnb reservation, which must still be drawn. Follows the mock structure of
 * `evidence-bookings-calendar.test.tsx`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";

vi.mock("@/lib/lease-pipeline-storage", () => ({
  LEASE_PIPELINE_EVENT: "lease-pipeline-changed",
  leasePipelineReadSucceeded: () => true,
  readLeasePipeline: () => LEASES,
  syncLeasePipelineFromServer: () => Promise.resolve(LEASES),
  leaseIsFullyExecuted: (row: { voidedAt?: string | null; status?: string; externallySignedLease?: boolean; fullySignedAt?: string | null }) => {
    if (row.voidedAt || row.status === "Voided") return false;
    if (row.externallySignedLease === true) return true;
    if (row.status === "Fully Signed") return true;
    return Boolean(row.fullySignedAt);
  },
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
// The room-block and stay-detail reads are plain portal GETs; jsdom has no
// server, so answer them emptily rather than let the screen show its (correct)
// "some bookings didn't load" band over a fixture problem.
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
            // Airbnb echoing PropLane's own stay back at us.
            ranges: [{ sourceUid: "echo-1", start: "2026-08-04", end: "2026-08-12", summary: "Airbnb (Not available)" }],
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
            // A real guest booking, which must still be drawn.
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
}));

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerPropertyBookingsPanel } from "@/components/portal/pro-property-bookings-panel";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

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

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
});
afterAll(() => vi.useRealTimers());

describe("evidence · Airbnb's echo of a PropLane stay is not drawn", () => {
  it("Room A shows one bar, Room B still shows the real Airbnb guest", async () => {
    const view = render(
      <AppUiProvider>
        <ManagerPropertyBookingsPanel
          propertyId="mgr-house-1"
          propertyLabel="4709A 8th Ave NE"
          submission={submission}
          managerUserId="mgr-1"
          showToast={() => {}}
        />
      </AppUiProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const bars = [...document.querySelectorAll('[data-attr="bookings-calendar-bar"]')];
    const labels = bars.map((bar) => `${bar.getAttribute("aria-label") ?? ""} ${bar.textContent ?? ""}`);
    // The PropLane stay is drawn once; the echo on the same room is gone.
    expect(labels.filter((label) => label.includes("Cv Ponce"))).toHaveLength(1);
    expect(labels.some((label) => label.includes("Not available"))).toBe(false);
    // The genuine Airbnb reservation on the other room survives, named.
    expect(labels.some((label) => label.includes("Maria Lopez"))).toBe(true);

    writeShot(
      "bookings-calendar-no-echo",
      "House → Bookings → Calendar, August 2026. Room A is let through PropLane (Cv Ponce, Aug 4–12) and Airbnb sends its own 'Not available' range back for the same room and dates — that echo used to draw a second overlapping bar and read as an overbooked room. It is now dropped: Room A has one bar. Room B's real Airbnb reservation is still drawn, under the guest's name.",
      view.container.innerHTML,
    );
  });
});
