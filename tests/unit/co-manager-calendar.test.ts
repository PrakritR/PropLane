import { describe, expect, it, vi } from "vitest";
import {
  dateSlotKey,
  readAvailabilityDateSetForStorageKey,
  slotIndexForDate,
  toLocalDateStr,
  type PartnerInquiry,
  type PlannedEvent,
} from "@/lib/demo-admin-scheduling";
import {
  listPropertyCalendarPeers,
  managerHadAvailabilityAtSlot,
  plannedTaskVisibleToViewer,
  plannedTourVisibleToViewer,
  tourInquiryVisibleToViewer,
  type ScheduledTourFilter,
} from "@/lib/co-manager-calendar";

const sharedStart = "2026-06-30T21:00:00.000Z";
const sharedSlotKey = (() => {
  const start = new Date(sharedStart);
  const slot = slotIndexForDate(start);
  return slot == null ? "2026-06-30:18" : dateSlotKey(toLocalDateStr(start), slot);
})();

vi.mock("@/lib/demo-admin-scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-admin-scheduling")>();
  return {
    ...actual,
    readAvailabilityDateSetForStorageKey: vi.fn(() => new Set([sharedSlotKey])),
    readPartnerInquiries: vi.fn(() => []),
    readPlannedEvents: vi.fn(() => []),
  };
});

vi.mock("@/lib/demo-property-pipeline", () => ({
  readAllExtraListings: vi.fn(() => [
    { id: "prop-1", managerUserId: "owner-1", title: "House A" },
  ]),
  readAllPendingManagerProperties: vi.fn(() => []),
}));

vi.mock("@/lib/manager-portfolio-access", () => ({
  readLinkedListingsForUser: vi.fn(() => []),
  // `viewerHasCalendarAccess` consults this for anyone who is not the listing
  // owner; an empty set means "no granted houses", which is what these fixtures
  // describe for every viewer except owner-1.
  collectLinkedPropertyIdsForModule: vi.fn(() => new Set<string>()),
}));

vi.mock("@/lib/pro-relationships", () => ({
  readProRelationships: vi.fn((userId: string) => {
    if (userId === "owner-1") {
      return [
        {
          id: "rel-1",
          linkedAxisId: "cm-axis",
          linkedUserId: "cm-1",
          linkedDisplayName: "Co Manager",
          perspective: "manager_tab",
          payoutPercentForManager: 15,
          assignedPropertyIds: ["prop-1"],
          propertyCoManagerPermissions: { "prop-1": { calendar: true } },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
    }
    return [];
  }),
}));

describe("co-manager-calendar", () => {
  const peers = [
    { userId: "owner-1", label: "You", isSelf: true },
    { userId: "cm-1", label: "Co Manager", isSelf: false },
  ];

  it("lists owner and linked co-manager for a property", () => {
    const result = listPropertyCalendarPeers("owner-1", "prop-1");
    expect(result.map((peer) => peer.userId).sort()).toEqual(["cm-1", "owner-1"]);
  });

  it("AXI-159: shows a pending tour to everyone with calendar access to the house", () => {
    const filter: ScheduledTourFilter = { viewerUserId: "owner-1", propertyId: "prop-1", peers };
    const row = {
      id: "inq-1",
      kind: "tour",
      status: "pending",
      managerUserId: "cm-1",
      propertyId: "prop-1",
      name: "Guest",
      email: "guest@example.com",
      phone: "",
      notes: "",
      proposedStart: "2026-06-30T21:00:00.000Z",
      proposedEnd: "2026-06-30T21:30:00.000Z",
      createdAt: "2026-06-29T00:00:00.000Z",
    } satisfies PartnerInquiry;

    // Booked with the co-manager, but on the owner's house: the owner sees it.
    // It used to be visible to the booked manager alone, so a request on a house
    // someone else runs day to day was invisible to them.
    expect(tourInquiryVisibleToViewer(row, filter)).toBe(true);
    expect(
      tourInquiryVisibleToViewer({ ...row, managerUserId: "owner-1" }, filter),
    ).toBe(true);
    // Access is still the gate — a house nobody granted stays hidden.
    expect(tourInquiryVisibleToViewer({ ...row, propertyId: "prop-9" }, { ...filter, propertyId: null })).toBe(
      false,
    );
  });

  it("AXI-159: a confirmed tour no longer depends on who published availability", () => {
    // The peer rule used to require PUBLISHED AVAILABILITY at that exact slot, so
    // a co-manager who never opened the availability grid — the common case — had
    // a confirmed tour on their own house simply not appear.
    vi.mocked(readAvailabilityDateSetForStorageKey).mockReturnValue(new Set());
    const filter: ScheduledTourFilter = { viewerUserId: "owner-1", propertyId: "prop-1", peers };
    const event = {
      id: "planned-1",
      title: "Tour · Guest",
      start: sharedStart,
      end: "2026-06-30T21:30:00.000Z",
      kind: "tour",
      managerUserId: "cm-1",
      propertyId: "prop-1",
    } satisfies PlannedEvent;

    expect(plannedTourVisibleToViewer(event, filter)).toBe(true);
  });

  it("AXI-159: an assigned tour reaches the assignee even without house access", () => {
    const filter: ScheduledTourFilter = { viewerUserId: "cm-2", propertyId: null, peers };
    const event = {
      id: "planned-1",
      title: "Tour · Guest",
      start: sharedStart,
      end: "2026-06-30T21:30:00.000Z",
      kind: "tour",
      managerUserId: "owner-1",
      propertyId: "prop-1",
      assignee: { type: "team", id: "cm-2", name: "Second Manager" },
    } satisfies PlannedEvent;

    expect(plannedTourVisibleToViewer(event, filter)).toBe(true);
    // A vendor id is not a user id, so it must never match a viewer.
    expect(
      plannedTourVisibleToViewer(
        { ...event, assignee: { type: "vendor", id: "cm-2", name: "Vendor" } },
        filter,
      ),
    ).toBe(false);
  });

  it("AXI-159: an assigned task block lands on the assignee's calendar", () => {
    // Assigning a tour creates a task block for that person — the whole point
    // being that it shows up on THEIR calendar, not the assigner's.
    const filter: ScheduledTourFilter = { viewerUserId: "cm-2", propertyId: null, peers };
    const event = {
      id: "task-1",
      title: "Tour · Guest",
      start: sharedStart,
      end: "2026-06-30T21:30:00.000Z",
      kind: "task",
      managerUserId: "owner-1",
      assignee: { type: "team", id: "cm-2", name: "Second Manager" },
    } satisfies PlannedEvent;

    expect(plannedTaskVisibleToViewer(event, filter)).toBe(true);
    expect(plannedTaskVisibleToViewer({ ...event, assignee: undefined }, filter)).toBe(false);
  });

  it("filters tours by multiple property ids", () => {
    const filter: ScheduledTourFilter = {
      viewerUserId: "owner-1",
      propertyId: null,
      propertyIds: ["prop-1"],
      peers,
    };
    const eventProp1 = {
      id: "planned-1",
      title: "Tour · Guest",
      start: sharedStart,
      end: "2026-06-30T21:30:00.000Z",
      kind: "tour",
      managerUserId: "owner-1",
      propertyId: "prop-1",
    } satisfies PlannedEvent;
    const eventProp2 = { ...eventProp1, id: "planned-2", propertyId: "prop-2" };

    expect(plannedTourVisibleToViewer(eventProp1, filter)).toBe(true);
    expect(plannedTourVisibleToViewer(eventProp2, filter)).toBe(false);
  });

  it("shows confirmed peer tours when viewer was also available", () => {
    vi.mocked(readAvailabilityDateSetForStorageKey).mockReturnValue(new Set([sharedSlotKey]));
    const filter: ScheduledTourFilter = { viewerUserId: "owner-1", propertyId: "prop-1", peers };
    const event = {
      id: "planned-1",
      title: "Tour · Guest",
      start: sharedStart,
      end: "2026-06-30T21:30:00.000Z",
      kind: "tour",
      managerUserId: "cm-1",
      propertyId: "prop-1",
    } satisfies PlannedEvent;

    expect(managerHadAvailabilityAtSlot("owner-1", "prop-1", event.start)).toBe(true);
    expect(plannedTourVisibleToViewer(event, filter)).toBe(true);
  });

  it("scopes manager tasks to the selected property filter", () => {
    const filter: ScheduledTourFilter = {
      viewerUserId: "owner-1",
      propertyId: "prop-1",
      propertyIds: ["prop-1"],
      peers: [],
    };
    const inScope = {
      id: "task-1",
      title: "Task · Turnover",
      start: sharedStart,
      end: "2026-06-30T21:30:00.000Z",
      kind: "task",
      managerUserId: "owner-1",
      propertyId: "prop-1",
    } satisfies PlannedEvent;
    const otherHouse = { ...inScope, id: "task-2", propertyId: "prop-2" };
    const otherManager = { ...inScope, id: "task-3", managerUserId: "cm-1" };

    expect(plannedTaskVisibleToViewer(inScope, filter)).toBe(true);
    expect(plannedTaskVisibleToViewer(otherHouse, filter)).toBe(false);
    expect(plannedTaskVisibleToViewer(otherManager, filter)).toBe(false);
    expect(
      plannedTaskVisibleToViewer(
        { ...inScope, id: "task-4", propertyId: undefined },
        filter,
      ),
    ).toBe(true);
  });
});
