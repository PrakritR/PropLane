// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { ManagerResidentsGroupedTable } from "@/components/portal/pro-residents-grouped-table";
import { ManagerToursGroupedTable } from "@/components/portal/pro-tours-grouped-table";
import { buildResidentListClustersByMode } from "@/lib/manager-resident-list-grouping";
import { clusterManagerTourListRowsByMode, type ManagerTourRow } from "@/lib/manager-tour-list";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";

/**
 * Residents, Vendors and Tours are the Properties card like every other list
 * tab (PLAN-0920-0436, Decide 1): one white card per person — initials tile,
 * name, place line, glyph facts, ⋯ — with no grouping box, no nested table and
 * no pill. What a row still has to say ("Incomplete application", a scheduled
 * reminder, "Canceled") is plain fact text. Each page also gets the Properties
 * search box wired through the control stack's `search` slot.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

function pillsIn(container: HTMLElement) {
  return container.querySelectorAll("[class*='badge'], [class*='rounded-full']");
}

describe("Residents card rows", () => {
  const rows = [
    {
      id: "AXIS-1",
      name: "Jordan Reyes",
      email: "jordan@example.com",
      propertyId: "h1",
      propertyLabel: "5259 Brooklyn Ave",
      roomLabel: "Room 4",
      leaseStart: "2026-08-15",
      groupId: "",
      statusLabel: "Incomplete application",
    },
    {
      id: "AXIS-2",
      name: "Taylor Brooks",
      email: "taylor@example.com",
      propertyId: "h1",
      propertyLabel: "5259 Brooklyn Ave",
      roomLabel: "Room 6",
      leaseStart: "2026-09-01",
      groupId: "",
    },
  ];

  it("draws one card per resident with email, lease start and the status as plain facts", () => {
    const clusters = buildResidentListClustersByMode(rows, new Map(), "house");
    const onToggle = vi.fn();
    const view = render(
      <ManagerResidentsGroupedTable
        clusters={clusters}
        groupMode="house"
        showPropertyInRows={false}
        onOpenResident={() => {}}
        selectable
        selectedIds={new Set()}
        onToggleSelected={onToggle}
      />,
    );

    expect(view.container.querySelector("[data-attr='residents-house-groups']")).toBeTruthy();
    const cards = view.container.querySelectorAll("[data-attr='resident-list-row']");
    expect(cards).toHaveLength(2);
    expect(view.container.querySelector("table")).toBeNull();
    expect(pillsIn(view.container)).toHaveLength(0);

    const first = cards[0]!;
    expect(first.textContent).toContain("Jordan Reyes");
    expect(first.textContent).toContain("Room 4 · 5259 Brooklyn Ave");
    const facts = first.querySelector("[data-attr='record-row-facts']")!;
    expect(facts.textContent).toContain("jordan@example.com");
    expect(facts.textContent).toContain("8/15/2026");
    expect(facts.querySelector("[data-attr='resident-row-status']")?.textContent).toBe("Incomplete application");

    // A current resident says nothing beyond the facts — no status at all.
    expect(cards[1]!.querySelector("[data-attr='resident-row-status']")).toBeNull();

    // Selection wiring survives the swap: the ⋯ / checkbox targets one resident.
    expect(view.container.querySelector("input[aria-label='Select Jordan Reyes']")).toBeTruthy();
  });
});

function tourRow(overrides: Partial<ManagerTourRow> & Pick<ManagerTourRow, "id" | "guestName">): ManagerTourRow {
  return {
    source: "planned",
    sourceId: overrides.id,
    guestEmail: "",
    guestPhone: "",
    propertyTitle: "5257 Brooklyn Ave",
    propertyId: "h1",
    roomLabel: "Room 3",
    whenLabel: "Thu, Sep 24 · 3:00 PM",
    startIso: "2026-09-24T22:00:00.000Z",
    endIso: "2026-09-24T22:30:00.000Z",
    startMs: Date.parse("2026-09-24T22:00:00.000Z"),
    endMs: Date.parse("2026-09-24T22:30:00.000Z"),
    statusLabel: "Confirmed",
    tourFormat: "in_person",
    bucket: "upcoming",
    ...overrides,
  };
}

function reminder(tourPlannedEventId: string): ScheduledInboxMessageRecord {
  return {
    id: `rem-${tourPlannedEventId}`,
    managerUserId: "m1",
    sendAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    status: "scheduled",
    subject: "Tour reminder",
    body: "",
    recipientEmail: "guest@example.com",
    recipientName: "Guest",
    deliverViaEmail: true,
    deliverViaSms: false,
    deliverViaInbox: true,
    createdAt: new Date().toISOString(),
    messageKind: "tour_reminder",
    tourPlannedEventId,
  };
}

describe("Tours card rows", () => {
  it("draws one card per tour; the reminder is a fact on its own row, the status only when it is not the bucket", () => {
    const rows = [
      tourRow({ id: "t1", guestName: "Ada Lovelace", guestEmail: "ada@example.com", guestPhone: "(206) 555-0100" }),
      tourRow({ id: "t2", guestName: "Grace Hopper", tourFormat: "virtual", statusLabel: "Canceled" }),
    ];
    const clusters = clusterManagerTourListRowsByMode(rows, "house");
    const view = render(
      <ManagerToursGroupedTable
        clusters={clusters}
        groupMode="house"
        onRowClick={() => {}}
        selectable
        selectedIds={new Set()}
        onToggleSelected={() => {}}
        tourReminders={[reminder("t1")]}
      />,
    );

    expect(view.container.querySelector("[data-attr='tours-house-groups']")).toBeTruthy();
    const cards = view.container.querySelectorAll("[data-attr='tour-list-row']");
    expect(cards).toHaveLength(2);
    expect(view.container.querySelector("table")).toBeNull();
    expect(pillsIn(view.container)).toHaveLength(0);
    expect(view.container.textContent).not.toContain("reminders scheduled");

    const ada = cards[0]!;
    expect(ada.textContent).toContain("Ada Lovelace");
    expect(ada.textContent).toContain("5257 Brooklyn Ave · Room 3");
    expect(ada.textContent).toContain("Thu, Sep 24 · 3:00 PM");
    expect(ada.textContent).toContain("ada@example.com");
    expect(ada.textContent).toContain("(206) 555-0100");
    expect(ada.querySelector("[data-attr='tours-row-scheduled']")?.textContent).toMatch(/^Next reminder /);
    expect(ada.querySelector("[data-attr='tour-row-status']")).toBeNull();

    const grace = cards[1]!;
    expect(grace.querySelector("[data-attr='tours-row-scheduled']")).toBeNull();
    expect(grace.textContent).toContain("Virtual");
    expect(grace.querySelector("[data-attr='tour-row-status']")?.textContent).toBe("Canceled");
    expect(view.container.textContent).not.toContain("Confirmed");
  });
});

describe("search box on Residents, Vendors and Tours", () => {
  it.each([
    ["src/components/portal/pro-residents.tsx", "residents"],
    ["src/components/portal/pro-vendors-panel.tsx", "vendors"],
    ["src/components/portal/pro-tours.tsx", "tours"],
  ])("%s passes search to the control stack and clears the no-match card", (file, noun) => {
    const source = read(file);
    expect(source).toContain(`placeholder: "Search ${noun}"`);
    expect(source).toContain(`dataAttr: "${noun}-search"`);
    expect(source).toContain("matchesPortalListSearch(");
    expect(source).toContain(`portalEmptyNoMatchTitle("${noun}"`);
    expect(source).toContain(`"${noun}-empty-clear-search"`);
  });
});
