// @vitest-environment jsdom
//
// EVIDENCE HARNESS (manager audit F-CAL-6).
//
// `/portal/calendar` showed a linked Google meeting as a Blocked half hour. The
// PER-PROPERTY availability editor — the screen where a manager actually
// publishes tour windows — fetched no busy time at all, so the same half hour
// rendered free and selectable. Publishing on it is a double-booking.
//
// This renders the REAL `ManagerPropertyTourPanel` against a stubbed
// `/api/portal/google-calendar/events` and counts the blocked cells on the
// grid. With EVIDENCE_DIR set it writes the rendered availability week.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startOfWeekMonday } from "@/lib/demo-admin-scheduling";

const MANAGER_ID = "mgr-evidence";

/** Three Google meetings in the CURRENT week, as the events route returns them. */
function busyMeetings() {
  const monday = startOfWeekMonday(new Date());
  const day = (offset: number) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, "0")}-${`${d.getDate()}`.padStart(2, "0")}`;
  };
  const at = (dateStr: string, slot: number) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d, Math.floor(slot / 2), (slot % 2) * 30).toISOString();
  };
  const block = (id, offset, startSlot, span, title) => ({
    id: `google_${id}`,
    source: "external",
    sourceId: id,
    dateStr: day(offset),
    startSlot,
    span,
    durationMinutes: span * 30,
    startIso: at(day(offset), startSlot),
    endIso: at(day(offset), startSlot + span),
    title,
    color: "bg-muted text-muted-foreground ring-border",
    googleCalendarPrivate: true,
  });
  return [
    block("g-1", 1, 18, 4, "Standup"),
    block("g-2", 2, 26, 2, "Vendor walkthrough"),
    block("g-3", 3, 20, 4, "Owner sync"),
  ];
}

const MEETINGS = busyMeetings();

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/properties",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: () => {} }) }));
vi.mock("@/components/portal/share-lead-link-modal", () => ({ ShareLeadLinkModal: () => null }));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));

vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/api/portal/google-calendar/events")) {
    return new Response(JSON.stringify({ meetings: MEETINGS }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ rows: [], records: [], inquiries: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

import { ManagerPropertyTourPanel } from "@/components/portal/manager-property-tour-panel";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; html: string }[] = [];
afterEach(cleanup);
afterAll(() => {
  if (!EVIDENCE_DIR || captured.length === 0) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html } of captured) writeFileSync(join(EVIDENCE_DIR, `${name}.fragment.html`), html, "utf8");
});

/**
 * Distinct half hours the availability grid draws as taken by an outside
 * commitment. Counted by the slot each cell names in its `aria-label`, because
 * the panel renders the same slot twice (a mobile day column and the desktop
 * week grid) and a raw element count double-counts today's column.
 */
function blockedSlots(root: HTMLElement): string[] {
  const slots = new Set<string>();
  for (const el of Array.from(root.querySelectorAll("button"))) {
    if (!/^Blocked$/i.test((el.textContent ?? "").trim())) continue;
    const label = el.getAttribute("aria-label") ?? "";
    const match = /Open details for (.+)$/.exec(label);
    if (match) slots.add(match[1]);
  }
  return Array.from(slots).sort();
}

describe("F-CAL-6 — the per-property availability editor shows the same conflicts", () => {
  it("renders Google busy time on the grid a manager publishes availability on", async () => {
    let openAvailabilityModal: (() => void) | null = null;
    const view = render(
      <ManagerPropertyTourPanel
        listingId="mgr-magnolia-2b-a1b2c3"
        managerUserId={MANAGER_ID}
        propertyLabel="The Magnolia · 2B"
        showToast={() => {}}
        onRegisterSetAvailability={(fn) => {
          openAvailabilityModal = fn;
        }}
      />,
    );
    await waitFor(() => expect(typeof openAvailabilityModal).toBe("function"));
    openAvailabilityModal!();
    // Modal portals outside the panel root — search the document for blocked cells.
    const root = document.body;
    const settled = await waitFor(() => expect(blockedSlots(root).length).toBeGreaterThan(0)).then(
      () => true,
      () => false,
    );
    captured.push({
      name: "f-cal-6-property-availability",
      html: root.innerHTML,
    });

    const blocked = blockedSlots(root);
    // eslint-disable-next-line no-console
    console.log(
      `\nF-CAL-6 evidence — property availability grid: ${blocked.length} blocked half hours\n` +
        blocked.map((slot) => `    ${slot}`).join("\n") +
        "\n",
    );

    expect(settled).toBe(true);
    // Three Google meetings spanning 4 + 2 + 4 half-hour slots.
    expect(blocked).toHaveLength(10);
  });
});
