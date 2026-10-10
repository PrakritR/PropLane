// @vitest-environment jsdom
/**
 * Render regression + evidence harness: renders one house's Bookings
 * calendar with BOTH channels — a PropLane lease and an Airbnb import — plus
 * the "Link Airbnb" modal, and dumps the markup for screenshotting.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";

// PARTIAL mock: every export the calendar's import chain reaches must be
// listed, or Vitest throws while building the mock and fails the whole file.
vi.mock("@/lib/lease-pipeline-storage", () => ({
  LEASE_PIPELINE_EVENT: "lease-pipeline-changed",
  leasePipelineReadSucceeded: () => true,
  readLeasePipeline: () => LEASES,
  syncLeasePipelineFromServer: () => Promise.resolve(LEASES),
  // Mirrors the real predicate closely enough for the fixtures here, which
  // carry `status`/`fullySignedAt` rather than signature pairs.
  leaseIsFullyExecuted: (row: {
    voidedAt?: string | null;
    status?: string;
    externallySignedLease?: boolean;
    fullySignedAt?: string | null;
  }) => {
    if (row.voidedAt || row.status === "Voided") return false;
    if (row.externallySignedLease === true) return true;
    if (row.status === "Fully Signed") return true;
    return Boolean(row.fullySignedAt);
  },
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
// N080: Bookings now drops a lease whose resident has no surviving directory
// (application) row. This fixture's lease is a real, executed stay, so give
// it a matching application row rather than letting the new filter treat it
// as orphaned data.
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
            connectionId: "conn-1",
            roomId: "room-b",
            roomLabel: "Room B",
            provider: "airbnb",
            label: "Airbnb · Room B",
            ranges: [{ start: "2026-08-18", end: "2026-08-22", summary: "Airbnb (Not available)" }],
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

// PRP-398: Bookings draws only FULLY EXECUTED leases — an offer still out for
// signature no longer holds the room. `stageLabel` is display copy the predicate
// never reads, so the executed state has to be stated as `status`/`fullySignedAt`.
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

// Same convention as `evidence-manager-money-agreement.test.tsx`: the render is
// always exercised, the HTML is only written when EVIDENCE_DIR asks for it.
const OUT = process.env.EVIDENCE_DIR ?? "";

function writeShot(name: string, caption: string, body: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<div style="max-width:1100px;margin:16px auto;padding:0 16px">
<p style="font:600 13px/1.4 system-ui;color:#64748b;margin:0 0 10px">${caption}</p>
${body}</div></body></html>`,
  );
}

/**
 * The calendar opens on the CURRENT month and has no prop to override it, while
 * both fixtures below sit in August 2026. Without a pinned clock this file
 * passed only during August. Fake `Date` only, so React's timers stay real.
 */
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

describe("evidence · one house's Bookings calendar shows both channels", () => {
  it("draws PropLane stays alongside Airbnb imports", async () => {
    const view = render(
      // The redesigned panel reads the shared toast context (PRP-333), so it
      // needs the provider the real portal always mounts above it.
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
    // C2-CAL2 moves occupancy into the property's strip and draws each stay
    // once as a bar; date headers no longer carry per-day capacity counts.
    const bars = [...document.querySelectorAll('[data-attr="bookings-calendar-bar"]')];
    expect(bars.some(bar => bar.textContent?.includes("Cv Ponce"))).toBe(true);
    expect(bars.some(bar => bar.getAttribute("aria-label")?.includes("Airbnb"))).toBe(true);
    expect(document.querySelector('[title="100% occupied"]')).toBeTruthy();
    // The colour key is a quiet legend row under the calendar, not a dropdown.
    const legend = document.querySelector('[data-attr="bookings-calendar-legend"]');
    expect(legend?.textContent).toContain("Confirmed");
    expect(legend?.textContent).toContain("Airbnb / Booking.com");
    const airbnbDay = document.querySelector('[data-attr="portfolio-booking-day-2026-08-18"]');
    expect(airbnbDay).toBeTruthy();
    expect(airbnbDay?.textContent).not.toContain("1/1");
    fireEvent.click(document.querySelector('button[data-attr="bookings-bucket-inhouse"]')!);
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain("Cv Ponce");
    fireEvent.click(document.querySelector('button[data-attr="bookings-bucket-upcoming"]')!);
    await act(async () => {
      await Promise.resolve();
    });
    writeShot(
      "bookings-calendar",
      "I · House → Bookings. Aug 4–12 is a PropLane lease (Cv Ponce, Room A); Aug 18–22 came in from the linked Airbnb calendar. The screen used to draw only the Airbnb half, so a room let through PropLane read as free.",
      view.container.innerHTML,
    );

    // The Calendars dropdown is gone from the command bar (Link calendars lives on Settings > Integrations).
    expect(document.querySelector('button[data-attr="portfolio-bookings-link-airbnb"]')).toBeNull();
  });
});
