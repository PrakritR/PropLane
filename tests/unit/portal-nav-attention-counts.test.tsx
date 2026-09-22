// @vitest-environment jsdom
//
// PLAN-0921-0001 — every sidebar number is a to-do count computed from the
// same rows its destination page renders. Properties (inventory) carries no
// badge; Payments is overdue-only; Tasks turns the alert pill on only with a
// late task; Leases counts both signing-stalled tabs; the resident counts
// mirror My home's own gates.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

const inboxState = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
const appState = vi.hoisted(() => ({ managerRows: [] as Array<Record<string, unknown>>, residentRows: [] as Array<Record<string, unknown>> }));
const taskState = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
const managerChargeState = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
const residentChargeState = vi.hoisted(() => ({ rows: [] as Array<{ id: string; bucket: "pending" | "overdue" | "paid" }> }));
const leaseState = vi.hoisted(() => ({
  managerRows: [] as Array<Record<string, unknown>>,
  residentLease: null as { bucket: string; status: string } | null,
}));

vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal-inbox-storage")>();
  return { ...actual, loadPersistedInbox: () => inboxState.rows };
});
vi.mock("@/lib/manager-sms-archive.client", () => ({
  loadManagerSmsArchivedIds: () => new Set(),
  MANAGER_SMS_ARCHIVE_CHANGED_EVENT: "manager-sms-archive-changed",
}));
vi.mock("@/components/portal/resident-inbox-panel", () => ({ RESIDENT_INBOX_THREAD_FALLBACK: [] }));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "user-1", email: "resident@example.com", ready: true }),
}));
vi.mock("@/lib/portal-data-store", () => ({ prefetchPortalData: () => Promise.resolve() }));
vi.mock("@/lib/demo-admin-partner-inbox", () => ({ readInboxMessages: () => [] }));
vi.mock("@/lib/demo-admin-scheduling", () => ({
  readPartnerInquiries: () => [],
  syncScheduleRecordsFromServer: () => Promise.resolve(),
}));
vi.mock("@/lib/demo-admin-ui", () => ({ ADMIN_UI_EVENT: "admin-ui" }));
vi.mock("@/lib/demo-property-pipeline", () => ({ PROPERTY_PIPELINE_EVENT: "property-pipeline" }));
vi.mock("@/lib/manager-portfolio-access", () => ({
  applicationVisibleToPortalUser: () => true,
  moduleRowVisibleToPortalUser: () => true,
}));
vi.mock("@/lib/manager-applications-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-applications-storage")>();
  return {
    ...actual,
    MANAGER_APPLICATIONS_EVENT: "manager-applications",
    readManagerApplicationRows: () => appState.managerRows,
    approvedApplicationAxisIdForResidentEmail: () => null,
  };
});
vi.mock("@/lib/rental-application/application-policy", () => ({
  applicationsForResidentEmail: () => appState.residentRows,
}));
vi.mock("@/lib/manager-work-orders-storage", () => ({
  MANAGER_WORK_ORDERS_EVENT: "manager-work-orders",
  readManagerWorkOrderRows: () => [],
}));
vi.mock("@/lib/service-requests-storage", () => ({
  SERVICE_REQUESTS_EVENT: "service-requests",
  readAllServiceRequests: () => [],
}));
vi.mock("@/lib/portal-bug-feedback", () => ({ readBugFeedbackRows: () => [] }));
vi.mock("@/lib/manager-tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-tasks")>();
  return { ...actual, readManagerTasksLocal: () => taskState.rows };
});
vi.mock("@/lib/manager-payments-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-payments-scope")>();
  return { ...actual, readManagerPaymentsLedgerCharges: () => managerChargeState.rows };
});
vi.mock("@/lib/household-charges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/household-charges")>();
  return {
    ...actual,
    readChargesForResident: () => residentChargeState.rows,
    // Sidesteps due-date/status parsing — this suite tests the hook's own
    // aggregation, not the bucket classifier (covered elsewhere).
    householdChargeManagerBucket: (c: { bucket: "pending" | "overdue" | "paid" }) => c.bucket,
  };
});
vi.mock("@/lib/lease-pipeline-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lease-pipeline-storage")>();
  return {
    ...actual,
    readLeasePipeline: () => leaseState.managerRows,
    findLeaseForResidentEmail: () => leaseState.residentLease,
  };
});

import { usePortalNavCounts } from "@/hooks/use-portal-nav-counts";

beforeEach(() => {
  inboxState.rows = [];
  appState.managerRows = [];
  appState.residentRows = [];
  taskState.rows = [];
  managerChargeState.rows = [];
  residentChargeState.rows = [];
  leaseState.managerRows = [];
  leaseState.residentLease = null;
});
afterEach(cleanup);

describe("Manager sidebar counts", () => {
  it("gives Properties no badge at all", () => {
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.properties).toBeUndefined();
  });

  it("Payments counts only the Overdue tab, ignoring pending charges", () => {
    managerChargeState.rows = [
      { id: "c1", bucket: "overdue" },
      { id: "c2", bucket: "pending" },
      { id: "c3", bucket: "pending" },
    ];
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.payments?.count).toBe(1);
    expect(result.current.payments?.tone).toBe("alert");
  });

  it("hides the Payments badge when nothing is overdue", () => {
    managerChargeState.rows = [{ id: "c1", bucket: "pending" }];
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.payments?.count).toBe(0);
  });

  it("Tasks counts every open task and turns alert only with a late one", () => {
    taskState.rows = [
      { id: "t1", completed: false, dueDate: "2020-01-01T00:00:00.000Z" },
      { id: "t2", completed: false, dueDate: "2030-01-01T00:00:00.000Z" },
      { id: "t3", completed: true, dueDate: "2020-01-01T00:00:00.000Z" },
    ];
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.tasks?.count).toBe(2);
    expect(result.current.tasks?.tone).toBe("alert");
  });

  it("Tasks stays the quiet number when nothing open is late", () => {
    taskState.rows = [{ id: "t1", completed: false, dueDate: "2030-01-01T00:00:00.000Z" }];
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.tasks?.count).toBe(1);
    expect(result.current.tasks?.tone).toBe("muted");
  });

  it("Leases counts leases awaiting the resident's signature and awaiting countersign, not drafts or completed", () => {
    leaseState.managerRows = [
      { id: "l1", bucket: "resident", status: "Resident Signature Pending" },
      { id: "l2", bucket: "signed", status: "Manager Signature Pending" },
      { id: "l3", bucket: "manager", status: "Manager Review" },
      { id: "l4", bucket: "signed", status: "Fully Signed" },
    ];
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.leases?.count).toBe(2);
    expect(result.current.leases?.tone).toBe("muted");
  });
});

describe("Resident sidebar counts", () => {
  it("Application counts 1 only for an unsubmitted draft", () => {
    appState.residentRows = [{ id: "AXIS-1", bucket: "pending", stage: "In progress" }];
    const { result } = renderHook(() => usePortalNavCounts("resident"));
    expect(result.current.applications?.count).toBe(1);
  });

  it("Application is 0 once submitted", () => {
    appState.residentRows = [{ id: "AXIS-1", bucket: "pending", stage: "Submitted" }];
    const { result } = renderHook(() => usePortalNavCounts("resident"));
    expect(result.current.applications?.count).toBe(0);
  });

  it("Lease counts 1 only while waiting on the resident's own signature", () => {
    leaseState.residentLease = { bucket: "resident", status: "Resident Signature Pending" };
    const { result } = renderHook(() => usePortalNavCounts("resident"));
    expect(result.current.lease?.count).toBe(1);
  });

  it("Lease is 0 once fully signed", () => {
    leaseState.residentLease = { bucket: "signed", status: "Fully Signed" };
    const { result } = renderHook(() => usePortalNavCounts("resident"));
    expect(result.current.lease?.count).toBe(0);
  });

  it("Payments counts due-or-overdue unpaid charges, alert only when one is overdue", () => {
    residentChargeState.rows = [
      { id: "c1", bucket: "pending" },
      { id: "c2", bucket: "paid" },
    ];
    const { result } = renderHook(() => usePortalNavCounts("resident"));
    expect(result.current.payments?.count).toBe(1);
    expect(result.current.payments?.tone).toBe("muted");
  });

  it("Payments turns alert once a charge is overdue", () => {
    residentChargeState.rows = [
      { id: "c1", bucket: "pending" },
      { id: "c2", bucket: "overdue" },
    ];
    const { result } = renderHook(() => usePortalNavCounts("resident"));
    expect(result.current.payments?.count).toBe(2);
    expect(result.current.payments?.tone).toBe("alert");
  });

  it("hides every badge at zero", () => {
    const { result } = renderHook(() => usePortalNavCounts("resident"));
    expect(result.current.applications?.count).toBe(0);
    expect(result.current.lease?.count).toBe(0);
    expect(result.current.payments?.count).toBe(0);
    expect(result.current.communication?.count).toBe(0);
  });
});
