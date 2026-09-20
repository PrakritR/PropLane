// @vitest-environment jsdom
//
// PRP-493 — pending submitted applications use the Application count, and that
// count is the blue alert pill (same as Communication). Withdrawn / in-progress
// rows stay off the badge. Residents is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen } from "@testing-library/react";

const appState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));

const inboxState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));

const EMAIL_UNREAD = {
  id: "thr-1000000001",
  folder: "inbox",
  from: "Property manager",
  email: "manager@example.com",
  subject: "Welcome to your unit",
  body: "Move-in info",
  time: "Jul 20, 2026",
  unread: true,
};
const SMS_NOTICE_UNREAD = {
  id: "thr-1000000002",
  folder: "inbox",
  from: "+12065550147",
  email: "+12065550147",
  subject: "New SMS in your inbox",
  body: "On my way",
  time: "Jul 21, 2026",
  unread: true,
};
const EMAIL_READ = { ...EMAIL_UNREAD, id: "thr-1000000003", unread: false };
const SENT = { ...EMAIL_UNREAD, id: "thr-1000000004", folder: "sent" };

const SUBMITTED = {
  id: "AXIS-1",
  name: "Aarav Jain",
  property: "5257 Brooklyn",
  bucket: "pending",
  stage: "Submitted",
  detail: "Submitted just now",
  propertyId: "prop-1",
};
const IN_PROGRESS = {
  ...SUBMITTED,
  id: "AXIS-2",
  stage: "In progress",
  detail: "Started yesterday",
};
const WITHDRAWN = {
  ...SUBMITTED,
  id: "AXIS-3",
  withdrawnAt: "2026-07-22T00:00:00.000Z",
};

vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal-inbox-storage")>();
  return {
    ...actual,
    loadPersistedInbox: () => inboxState.rows,
  };
});
vi.mock("@/lib/manager-sms-archive.client", () => ({
  loadManagerSmsArchivedIds: () => new Set(),
  MANAGER_SMS_ARCHIVE_CHANGED_EVENT: "manager-sms-archive-changed",
}));
vi.mock("@/components/portal/resident-inbox-panel", () => ({ RESIDENT_INBOX_THREAD_FALLBACK: [] }));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "user-1", email: "u@example.com", ready: true }),
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
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications",
  readManagerApplicationRows: () => appState.rows,
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
vi.mock("@/hooks/use-is-native-app", () => ({ useNativeChrome: () => false }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/portal-nav-prefetch", () => ({ portalMobileLinkPrefetchEnabled: () => false }));
vi.mock("@/lib/portal-nav-client", () => ({
  isCrossPortalNavigation: () => false,
  portalNavClick: () => () => {},
}));

import { usePortalNavCounts } from "@/hooks/use-portal-nav-counts";
import { portalNavCountTone } from "@/components/portal/portal-sidebar";
import { PortalNativeMoreSheet } from "@/components/portal/portal-native-more-sheet";

beforeEach(() => {
  appState.rows = [];
  inboxState.rows = [EMAIL_UNREAD, SMS_NOTICE_UNREAD, EMAIL_READ, SENT];
});
afterEach(cleanup);

function renderSheet(items: Parameters<typeof PortalNativeMoreSheet>[0]["items"]) {
  return render(
    <PortalNativeMoreSheet
      open
      onOpenChange={() => {}}
      items={items}
      kind="manager"
      activeSection="dashboard"
      showNavIcons={false}
    />,
  );
}

describe("Application nav count uses submitted pending rows only", () => {
  it("counts a submitted pending application as 1", () => {
    appState.rows = [SUBMITTED];
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.applications).toBe(1);
    expect(result.current.residents).toBeUndefined();
  });

  it("does not count withdrawn or in-progress rows", () => {
    appState.rows = [IN_PROGRESS, WITHDRAWN];
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.applications).toBe(0);
  });

  it("keeps Communication independent of the application queue", () => {
    appState.rows = [SUBMITTED];
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.applications).toBe(1);
    expect(result.current.communication).toBe(1);
  });
});

describe("Application uses the same alert tone as Communication", () => {
  it("treats Application and Communication as alert, Residents as muted", () => {
    expect(portalNavCountTone("applications")).toBe("alert");
    expect(portalNavCountTone("communication")).toBe("alert");
    expect(portalNavCountTone("residents")).toBe("muted");
    expect(portalNavCountTone("properties")).toBe("muted");
  });

  it("paints Application as a blue pill in More, not a grey number", () => {
    renderSheet([
      {
        section: "applications",
        sectionTabId: "application",
        label: "Application",
        href: "/portal/applications/pending",
        count: 1,
        countTone: "alert",
      },
      { section: "properties", label: "Properties", href: "/portal/properties", count: 3 },
    ]);
    const application = screen.getByRole("link", { name: "Application" });
    const appBadge = application.querySelector("[data-attr='nav-count']");
    expect(appBadge?.textContent).toBe("1");
    expect(appBadge?.className).toContain("bg-primary");

    const properties = screen.getByRole("link", { name: "Properties" });
    const propBadge = properties.querySelector("[data-attr='nav-count']");
    expect(propBadge?.textContent).toBe("3");
    expect(propBadge?.className).not.toContain("bg-primary");
  });

  it("Application stays alert in More even when countTone is omitted", () => {
    renderSheet([
      { section: "applications", label: "Application", href: "/portal/applications/pending", count: 2 },
    ]);
    const row = screen.getByRole("link", { name: "Application" });
    expect(row.querySelector("[data-attr='nav-count']")?.className).toContain("bg-primary");
  });
});
