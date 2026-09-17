// @vitest-environment jsdom
//
// The Communication nav badge must match unread rows Active would show.
// Hidden leftover assistant notices do not count. Same-tab inbox changes
// recount the badge without a reload.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

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
const LIVE_ASSISTANT_READ = {
  id: "agent_notice_user-1",
  folder: "inbox",
  from: "PropLane Assistant",
  email: "",
  subject: "PropLane Assistant",
  body: "Seen",
  preview: "Seen",
  time: "",
  unread: false,
  threadType: "agent_notice",
};
const LEFTOVER_ASSISTANT_UNREAD = {
  id: "agent_notice_user-1__ghost",
  folder: "inbox",
  from: "PropLane Assistant",
  email: "",
  subject: "PropLane Assistant",
  body: "Old workspace",
  preview: "Old workspace",
  time: "",
  unread: true,
  threadType: "agent_notice",
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
vi.mock("@/lib/rental-application/in-progress-application", () => ({
  isSubmittedPendingApplicationRow: () => false,
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications",
  readManagerApplicationRows: () => [],
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

import { PORTAL_INBOX_CHANGED_EVENT } from "@/lib/portal-inbox-storage";
import { usePortalNavCounts } from "@/hooks/use-portal-nav-counts";

beforeEach(() => {
  inboxState.rows = [EMAIL_UNREAD, SMS_NOTICE_UNREAD, EMAIL_READ, SENT];
});
afterEach(cleanup);

describe("Communication nav badge counts what the conversation list shows", () => {
  it("counts an unread inbound-SMS notice for the resident badge", () => {
    const { result } = renderHook(() => usePortalNavCounts("resident"));
    // Active unread is folder === inbox after collapse. The email/sent pair
    // becomes one row; the SMS notice is the unread conversation Active shows.
    expect(result.current.communication).toBe(1);
  });

  it("counts an unread inbound-SMS notice for the manager badge", () => {
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.communication).toBe(1);
  });

  it("does not count a leftover hidden assistant notice", () => {
    inboxState.rows = [LIVE_ASSISTANT_READ, LEFTOVER_ASSISTANT_UNREAD];
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.communication).toBe(0);
  });

  it("recounts after a same-tab inbox change", () => {
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.communication).toBe(1);
    inboxState.rows = [EMAIL_READ, LIVE_ASSISTANT_READ];
    act(() => {
      window.dispatchEvent(new CustomEvent(PORTAL_INBOX_CHANGED_EVENT, { detail: { key: "manager-inbox" } }));
    });
    expect(result.current.communication).toBe(0);
  });
});
