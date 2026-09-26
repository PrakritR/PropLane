/**
 * C026/C032 — server rules for the Tours CSV/PDF export.
 *
 * `projectScheduleRecordsForViewer` (the shared access-projection every reader
 * of the planned-events/partner-inquiries singletons goes through) and
 * `activeWorkspacePropertyScope` are stubbed to their identity/pass-through
 * behavior so these tests exercise `loadManagerTourExportRows`'s OWN rules —
 * the "fully owned only" export gate, workspace narrowing, and bucket/
 * property/search filtering — not re-verify the shared projection itself.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/schedule-record-projection.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/schedule-record-projection.server")>(
    "@/lib/schedule-record-projection.server",
  );
  return {
    ...actual,
    // Identity pass-through: these tests supply already-"owned" or already-"foreign" raw
    // records directly, so the export gate under test is `loadManagerTourExportRows`'s own
    // `ownedItem` filter, not the shared projection's full/busy/exclude decision.
    projectScheduleRecordsForViewer: vi.fn(async (_db: unknown, _user: unknown, records: unknown) => records),
  };
});

vi.mock("@/lib/workspaces/scope.server", () => ({
  activeWorkspacePropertyScope: vi.fn(async () => null),
}));

import { loadManagerTourExportRows, tourRowsToReportResult } from "@/lib/manager-tour-export.server";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";
import type { ManagerTourRow } from "@/lib/manager-tour-list";

const PARTNER_INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";
const PLANNED_EVENTS_RECORD_ID = "axis_admin_planned_events_v1";

function futureIso(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
}

function fakeDb(records: Record<string, unknown>[]) {
  return {
    from: () => ({
      select: () => ({
        in: async () => ({ data: records, error: null }),
      }),
    }),
  } as unknown as Parameters<typeof loadManagerTourExportRows>[0]["db"];
}

function inquiryRecord(items: Record<string, unknown>[]) {
  return {
    id: PARTNER_INQUIRIES_RECORD_ID,
    row_data: { id: PARTNER_INQUIRIES_RECORD_ID, recordType: PARTNER_INQUIRIES_RECORD_ID, payload: items },
  };
}

function plannedRecord(items: Record<string, unknown>[]) {
  return {
    id: PLANNED_EVENTS_RECORD_ID,
    row_data: { id: PLANNED_EVENTS_RECORD_ID, recordType: PLANNED_EVENTS_RECORD_ID, payload: items },
  };
}

const VIEWER = { id: "mgr-1", role: "manager", roles: ["manager"] };

describe("loadManagerTourExportRows", () => {
  it("includes only tours this viewer owns — a peer's item (different managerUserId) is excluded, never shaped into a name-less row", async () => {
    const myPending = {
      id: "inq-mine",
      kind: "tour",
      status: "pending",
      managerUserId: "mgr-1",
      name: "Alex Guest",
      email: "alex@example.com",
      phone: "",
      propertyId: "prop-1",
      propertyTitle: "5259 Brooklyn Ave",
      requestedWindows: [{ start: futureIso(24), end: futureIso(25) }],
    };
    const peerBusyItem = {
      // Shape a `busyProjection`-redacted peer item would have: no name/email/propertyTitle.
      id: "inq-peer",
      kind: "tour",
      status: "pending",
      managerUserId: "mgr-2",
      propertyId: "prop-2",
      requestedWindows: [{ start: futureIso(24), end: futureIso(25) }],
    };
    const db = fakeDb([inquiryRecord([myPending, peerBusyItem])]);

    const rows = await loadManagerTourExportRows({
      db,
      user: VIEWER,
      bucket: "pending",
      propertyFilters: [],
      search: "",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.guestName).toBe("Alex Guest");
    expect(rows[0]?.sourceId).toBe("inq-mine");
  });

  it("an admin viewer exports every owner's tours, not only their own", async () => {
    const item = {
      id: "inq-owned-by-someone-else",
      kind: "tour",
      status: "pending",
      managerUserId: "mgr-owner",
      name: "Jordan Prospect",
      email: "jordan@example.com",
      propertyId: "prop-9",
      propertyTitle: "4709A 8th Ave",
      requestedWindows: [{ start: futureIso(24), end: futureIso(25) }],
    };
    const db = fakeDb([inquiryRecord([item])]);

    const rows = await loadManagerTourExportRows({
      db,
      user: { id: "admin-1", role: "admin", roles: ["admin"] },
      bucket: "pending",
      propertyFilters: [],
      search: "",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.guestName).toBe("Jordan Prospect");
  });

  it("filters to the requested bucket — a confirmed planned tour never appears in a Pending export", async () => {
    const planned = {
      id: "planned-1",
      kind: "tour",
      managerUserId: "mgr-1",
      attendeeName: "Casey Confirmed",
      attendeeEmail: "casey@example.com",
      propertyId: "prop-1",
      propertyTitle: "5259 Brooklyn Ave",
      start: futureIso(48),
      end: futureIso(49),
    };
    const db = fakeDb([plannedRecord([planned])]);

    const pending = await loadManagerTourExportRows({ db, user: VIEWER, bucket: "pending", propertyFilters: [], search: "" });
    expect(pending).toHaveLength(0);

    const upcoming = await loadManagerTourExportRows({ db, user: VIEWER, bucket: "upcoming", propertyFilters: [], search: "" });
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.guestName).toBe("Casey Confirmed");
  });

  it("respects the active property filter and search query, same as the on-screen list", async () => {
    const items = [
      {
        id: "inq-a",
        kind: "tour",
        status: "pending",
        managerUserId: "mgr-1",
        name: "Alex Guest",
        propertyId: "prop-1",
        propertyTitle: "5259 Brooklyn Ave",
        requestedWindows: [{ start: futureIso(24), end: futureIso(25) }],
      },
      {
        id: "inq-b",
        kind: "tour",
        status: "pending",
        managerUserId: "mgr-1",
        name: "Bailey Guest",
        propertyId: "prop-2",
        propertyTitle: "4709A 8th Ave",
        requestedWindows: [{ start: futureIso(24), end: futureIso(25) }],
      },
    ];
    const db = fakeDb([inquiryRecord(items)]);

    const byProperty = await loadManagerTourExportRows({
      db,
      user: VIEWER,
      bucket: "pending",
      propertyFilters: ["prop-2"],
      search: "",
    });
    expect(byProperty).toHaveLength(1);
    expect(byProperty[0]?.guestName).toBe("Bailey Guest");

    const bySearch = await loadManagerTourExportRows({
      db,
      user: VIEWER,
      bucket: "pending",
      propertyFilters: [],
      search: "alex",
    });
    expect(bySearch).toHaveLength(1);
    expect(bySearch[0]?.guestName).toBe("Alex Guest");
  });

  it("narrows to the active workspace's properties for a manager viewer, never for an admin", async () => {
    const inWorkspace = {
      id: "inq-in-ws",
      kind: "tour",
      status: "pending",
      managerUserId: "mgr-1",
      name: "In Workspace",
      propertyId: "prop-1",
      propertyTitle: "5259 Brooklyn Ave",
      requestedWindows: [{ start: futureIso(24), end: futureIso(25) }],
    };
    const outOfWorkspace = {
      id: "inq-out-ws",
      kind: "tour",
      status: "pending",
      managerUserId: "mgr-1",
      name: "Out Of Workspace",
      propertyId: "prop-9",
      propertyTitle: "Some Other House",
      requestedWindows: [{ start: futureIso(24), end: futureIso(25) }],
    };
    const db = fakeDb([inquiryRecord([inWorkspace, outOfWorkspace])]);

    vi.mocked(activeWorkspacePropertyScope).mockResolvedValueOnce(["prop-1"]);
    const scoped = await loadManagerTourExportRows({ db, user: VIEWER, bucket: "pending", propertyFilters: [], search: "" });
    expect(scoped.map((r) => r.guestName)).toEqual(["In Workspace"]);
  });
});

describe("tourRowsToReportResult", () => {
  it("shapes rows into the generic ReportResult every CSV/PDF export renders from", () => {
    const row: ManagerTourRow = {
      id: "inquiry-inq-1-0",
      source: "inquiry",
      sourceId: "inq-1",
      guestName: "Alex Guest",
      guestEmail: "alex@example.com",
      guestPhone: "",
      propertyTitle: "5259 Brooklyn Ave",
      propertyId: "prop-1",
      roomLabel: "Room 3",
      whenLabel: "Thu, Sep 17, 4:00 PM",
      startIso: futureIso(24),
      endIso: futureIso(25),
      startMs: Date.now() + 86_400_000,
      endMs: Date.now() + 90_000_000,
      statusLabel: "Pending",
      tourFormat: "in_person",
      bucket: "pending",
    };

    const report = tourRowsToReportResult([row], "pending");
    expect(report.title).toBe("Tours — Pending");
    expect(report.rows).toEqual([
      {
        guest: "Alex Guest",
        property: "5259 Brooklyn Ave · Room 3",
        when: "Thu, Sep 17, 4:00 PM",
        format: "In person",
        status: "Pending",
        email: "alex@example.com",
        phone: "—",
      },
    ]);
  });
});
