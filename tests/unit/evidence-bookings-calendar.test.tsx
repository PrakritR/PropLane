// @vitest-environment jsdom
/**
 * Render regression + evidence harness: renders one house's Bookings
 * calendar with BOTH channels — a PropLane lease and an Airbnb import — plus
 * the "Link Airbnb" modal, and dumps the markup for screenshotting.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";

vi.mock("@/lib/lease-pipeline-storage", () => ({
  LEASE_PIPELINE_EVENT: "lease-pipeline-changed",
  readLeasePipeline: () => LEASES,
  syncLeasePipelineFromServer: () => Promise.resolve(LEASES),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/channel-calendar/client", () => ({
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
    roomChoice: "mgr-house-1::room-a",
    stageLabel: "Signed",
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
    // Both channels on one screen. PRP-333 split the single grid into buckets,
    // so they now land in different tabs by date rather than side by side: the
    // Airbnb import (Aug 18-22) is Upcoming and the PropLane lease (Aug 4-12)
    // is in-house on the pinned clock. Assert each where it actually lives —
    // the guarantee is that the PropLane half is drawn at all, which is what
    // used to be missing and made a let room read as free.
    expect(view.container.textContent).toContain("Airbnb");
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

    fireEvent.click(document.querySelector('button[data-attr="portfolio-bookings-link-airbnb"]')!);
    await act(async () => {
      await Promise.resolve();
    });
    writeShot(
      "bookings-link-airbnb",
      "J · The 'Link Airbnb' modal on the same panel.",
      document.body.innerHTML,
    );
  });
});
