// @vitest-environment jsdom
//
// Workspace isolation (Oct 20): one account owns several workspaces ("1. Ambika" holds 4709A 8th
// Ave, "2. Vinod" holds nothing). The manager Dashboard "Services needed" list, the Services list
// and the sidebar badges read the browser mirrors of the account's rows, and those readers narrowed
// by the VIEWER's user id, not by the ACTIVE workspace. With B active, A's service showed up.
//
// The fixture: an owner with workspace A (the default, one house, with a service, an application,
// a tour, a lease, an overdue payment) and workspace B (no houses). With B active every reader and
// every badge count returns nothing from A; with A active they return A's rows; and a teammate
// seated only in B never sees A.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { WorkspacePayload } from "@/lib/workspaces/types";

const OWNER = "owner-1";
const TEAMMATE = "teammate-b";
const HOUSE_A = "prop-4709a";

const store = vi.hoisted(() => ({
  workOrders: [] as Array<Record<string, unknown>>,
  serviceRequests: [] as Array<Record<string, unknown>>,
  applications: [] as Array<Record<string, unknown>>,
  leases: [] as Array<Record<string, unknown>>,
  charges: [] as Array<Record<string, unknown>>,
  inquiries: [] as Array<Record<string, unknown>>,
  viewer: "owner-1",
}));

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: store.viewer, email: "owner@example.com", ready: true }),
}));
vi.mock("@/lib/portal-data-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal-data-store")>();
  return { ...actual, prefetchPortalData: () => Promise.resolve() };
});
vi.mock("@/lib/demo-admin-partner-inbox", () => ({ readInboxMessages: () => [] }));
vi.mock("@/lib/demo-admin-scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-admin-scheduling")>();
  return {
    ...actual,
    readPartnerInquiries: () => store.inquiries as never,
    readPlannedEvents: () => [],
    syncScheduleRecordsFromServer: () => Promise.resolve(),
  };
});
vi.mock("@/lib/demo-admin-ui", () => ({ ADMIN_UI_EVENT: "admin-ui" }));
vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal-inbox-storage")>();
  return { ...actual, loadPersistedInbox: () => [] };
});
vi.mock("@/lib/manager-sms-archive.client", () => ({
  loadManagerSmsArchivedIds: () => new Set(),
  MANAGER_SMS_ARCHIVE_CHANGED_EVENT: "manager-sms-archive-changed",
}));
vi.mock("@/components/portal/resident-inbox-panel", () => ({ RESIDENT_INBOX_THREAD_FALLBACK: [] }));
vi.mock("@/lib/portal-bug-feedback", () => ({ readBugFeedbackRows: () => [] }));
// The real moduleRowVisibleToPortalUser stays (it is the thing under test); only the application gate is stubbed.
vi.mock("@/lib/manager-portfolio-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-portfolio-access")>();
  return { ...actual, applicationVisibleToPortalUser: () => true };
});
vi.mock("@/lib/manager-applications-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-applications-storage")>();
  return {
    ...actual,
    MANAGER_APPLICATIONS_EVENT: "manager-applications",
    readManagerApplicationRows: () => store.applications,
    approvedApplicationAxisIdForResidentEmail: () => null,
  };
});
vi.mock("@/lib/manager-work-orders-storage", () => ({
  MANAGER_WORK_ORDERS_EVENT: "manager-work-orders",
  readManagerWorkOrderRows: () => store.workOrders,
}));
vi.mock("@/lib/service-requests-storage", () => ({
  SERVICE_REQUESTS_EVENT: "service-requests",
  readAllServiceRequests: () => store.serviceRequests,
}));
vi.mock("@/lib/manager-tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-tasks")>();
  return { ...actual, readManagerTasksLocal: () => [] };
});
vi.mock("@/lib/household-charges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/household-charges")>();
  // The browser mirror hands back every charge the account can read, across workspaces.
  return { ...actual, readChargesForManager: () => store.charges as never };
});
vi.mock("@/lib/lease-pipeline-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lease-pipeline-storage")>();
  return { ...actual, readLeasePipeline: () => store.leases };
});
vi.mock("@/lib/move-in-forms/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/move-in-forms/client")>();
  return { ...actual, loadMoveInForms: async () => ({ forms: [], unread: 0 }) };
});

import { usePortalNavCounts } from "@/hooks/use-portal-nav-counts";
import { moduleRowVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import { listManagerServiceCalendarMeetings } from "@/lib/manager-service-calendar";
import { setWorkspaceSelection } from "@/lib/workspaces/selection";

type Ws = WorkspacePayload["workspaces"][number];
const ws = (partial: Partial<Ws> & Pick<Ws, "id" | "name">): Ws =>
  ({ ownerUserId: OWNER, owned: true, isDefault: false, propertyIds: [], propertyPermissions: {}, ...partial }) as Ws;

const A = ws({ id: "w-ambika", name: "1. Ambika", isDefault: true, propertyIds: [HOUSE_A] });
const B = ws({ id: "w-vinod", name: "2. Vinod" });

function select(activeWorkspaceId: string, workspaces: Ws[] = [A, B]) {
  setWorkspaceSelection({ activeWorkspaceId, workspaces } as unknown as WorkspacePayload);
}

const workOrderInA = {
  id: "wo-lock",
  title: "Door lock does not lock; replace lock",
  propertyName: "4709A 8th Ave",
  unit: "Room 10",
  propertyId: HOUSE_A,
  managerUserId: OWNER,
  bucket: "open",
  residentEmail: "",
};
const serviceRequestInA = {
  id: "sr-1",
  offerName: "Cleaning",
  propertyId: HOUSE_A,
  managerUserId: OWNER,
  residentEmail: "",
  status: "pending",
  requestedAt: "2026-10-01T00:00:00.000Z",
};

beforeEach(() => {
  window.history.pushState({}, "", "/portal/dashboard");
  store.viewer = OWNER;
  store.workOrders = [workOrderInA];
  store.serviceRequests = [serviceRequestInA];
  store.applications = [{ id: "AX-1", propertyId: HOUSE_A, assignedPropertyId: HOUSE_A, bucket: "pending", stage: "Submitted" }];
  store.leases = [
    { id: "l1", propertyId: HOUSE_A, bucket: "resident", status: "Resident Signature Pending" },
    { id: "l2", propertyId: HOUSE_A, bucket: "signed", status: "Manager Signature Pending" },
  ];
  store.charges = [
    {
      id: "ch-1",
      createdAt: "2020-01-01T00:00:00.000Z",
      residentEmail: "",
      residentName: "Pat Resident",
      residentUserId: null,
      propertyId: HOUSE_A,
      propertyLabel: "4709A 8th Ave",
      managerUserId: OWNER,
      kind: "rent",
      title: "October rent",
      amountLabel: "$900.00",
      balanceLabel: "$900.00",
      status: "pending",
      dueDateLabel: "Jan 1, 2020",
      blocksLeaseUntilPaid: false,
    },
  ];
  store.inquiries = [
    {
      id: "tour-1",
      kind: "tour",
      name: "Guest",
      email: "guest@example.com",
      phone: "",
      notes: "",
      managerUserId: OWNER,
      propertyId: HOUSE_A,
      propertyTitle: "4709A 8th Ave",
      proposedStart: "2030-01-01T17:00:00.000Z",
      proposedEnd: "2030-01-01T17:30:00.000Z",
      status: "pending",
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  ];
});
afterEach(() => {
  cleanup();
  setWorkspaceSelection(null);
});

describe("service rows (work orders and add-ons) follow the ACTIVE workspace", () => {
  it("shows A's work order and add-on while A is active", () => {
    select(A.id);
    expect(moduleRowVisibleToPortalUser(workOrderInA as never, OWNER, "services")).toBe(true);
    expect(moduleRowVisibleToPortalUser(serviceRequestInA as never, OWNER, "services")).toBe(true);
  });

  it("shows nothing from A while the empty workspace B is active, even for the row's own manager", () => {
    select(B.id);
    expect(moduleRowVisibleToPortalUser(workOrderInA as never, OWNER, "services")).toBe(false);
    expect(moduleRowVisibleToPortalUser(serviceRequestInA as never, OWNER, "services")).toBe(false);
  });

  it("matches a work order on either of its house columns", () => {
    select(A.id);
    const assignedOnly = { ...workOrderInA, propertyId: "", assignedPropertyId: HOUSE_A };
    expect(moduleRowVisibleToPortalUser(assignedOnly as never, OWNER, "services")).toBe(true);
    select(B.id);
    expect(moduleRowVisibleToPortalUser(assignedOnly as never, OWNER, "services")).toBe(false);
  });

  it("keeps a row that names no house out of every non-default workspace", () => {
    const loose = { ...workOrderInA, id: "wo-loose", propertyId: "", assignedPropertyId: undefined };
    select(A.id);
    expect(moduleRowVisibleToPortalUser(loose as never, OWNER, "services")).toBe(true);
    select(B.id);
    expect(moduleRowVisibleToPortalUser(loose as never, OWNER, "services")).toBe(false);
  });

  it("the services calendar draws A's scheduled visit only in A", () => {
    store.workOrders = [{ ...workOrderInA, bucket: "scheduled", scheduledAtIso: "2026-10-22T17:00:00.000Z", scheduledTime: "10:00" }];
    select(A.id);
    expect(listManagerServiceCalendarMeetings(OWNER, null).length).toBe(1);
    select(B.id);
    // The calendar passes no house filter for an empty workspace: the workspace gate must still hold.
    expect(listManagerServiceCalendarMeetings(OWNER, null)).toEqual([]);
  });

  it("a teammate seated only in B never sees A", () => {
    select(B.id, [{ ...B, owned: false, ownerUserId: OWNER }]);
    expect(moduleRowVisibleToPortalUser(workOrderInA as never, TEAMMATE, "services")).toBe(false);
    expect(moduleRowVisibleToPortalUser({ ...serviceRequestInA, managerUserId: TEAMMATE } as never, TEAMMATE, "services")).toBe(false);
  });
});

describe("sidebar badges follow the ACTIVE workspace", () => {
  it("counts A's services, applications, leases, tours and overdue payments while A is active", () => {
    select(A.id);
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.services?.count).toBe(2);
    expect(result.current.applications?.count).toBe(1);
    expect(result.current.leases?.count).toBe(2);
    expect(result.current.payments?.count).toBe(1);
    expect(result.current.tours?.count).toBe(1);
  });

  it("is 0 on every badge while B is active", () => {
    select(B.id);
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.services?.count).toBe(0);
    expect(result.current.applications?.count).toBe(0);
    expect(result.current.leases?.count).toBe(0);
    expect(result.current.tours?.count).toBe(0);
    expect(result.current.payments?.count).toBe(0);
    expect(result.current.tasks?.count).toBe(0);
    expect(result.current.communication?.count).toBe(0);
    expect(result.current.forms?.count).toBe(0);
  });
});

describe("caches keyed on the viewer alone are keyed on the workspace too", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("move-in forms: a list read in A is not served in B", async () => {
    const real = await vi.importActual<typeof import("@/lib/move-in-forms/client")>("@/lib/move-in-forms/client");
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ forms: [], unread: select_active() === A.id ? 3 : 0, url }),
    }));
    let active = A.id;
    const select_active = () => active;
    vi.stubGlobal("fetch", fetchMock);
    select(A.id);
    const first = await real.loadMoveInForms("u-iso", "manager");
    expect(first.unread).toBe(3);
    active = B.id;
    select(B.id);
    const second = await real.loadMoveInForms("u-iso", "manager");
    expect(second.unread).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("document expiry: a summary read in A is not served in B", async () => {
    const { loadDocumentExpirationSummary, resetDocumentExpirationSummaryCache } = await import("@/lib/manager-document-expiry-client");
    resetDocumentExpirationSummaryCache();
    let active = A.id;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ summary: { workspace: active } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    select(A.id);
    expect(await loadDocumentExpirationSummary({ userId: "u-iso" })).toEqual({ workspace: A.id });
    active = B.id;
    select(B.id);
    expect(await loadDocumentExpirationSummary({ userId: "u-iso" })).toEqual({ workspace: B.id });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
    resetDocumentExpirationSummaryCache();
  });
});
