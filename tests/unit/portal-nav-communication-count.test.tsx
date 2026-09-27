// @vitest-environment jsdom
//
// The Communication nav badge must match unread rows Active would show.
// Hidden leftover assistant notices do not count. Same-tab inbox changes
// recount the badge without a reload.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const inboxState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));

const smsArchiveState = vi.hoisted(() => ({
  archivedIds: new Set<string>(),
}));
const workspaceState = vi.hoisted(() => ({ id: null as string | null }));

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
  loadManagerSmsArchivedIds: () => smsArchiveState.archivedIds,
  MANAGER_SMS_ARCHIVE_CHANGED_EVENT: "manager-sms-archive-changed",
}));
const smsConversationsState = vi.hoisted(() => ({
  residents: [] as Array<Record<string, unknown>>,
}));
const smsOpenedState = vi.hoisted(() => ({ ids: new Set<string>() }));
vi.mock("@/lib/manager-sms-conversations-client", () => ({
  loadManagerSmsConversationsClient: vi.fn(async () =>
    Response.json({ residents: smsConversationsState.residents }),
  ),
}));
vi.mock("@/lib/workspaces/selection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspaces/selection")>()),
  activeWorkspaceIdentity: () => workspaceState.id ? { id: workspaceState.id } : null,
}));
vi.mock("@/lib/manager-sms-opened.client", () => ({
  loadManagerSmsOpenedIds: () => smsOpenedState.ids,
  markManagerSmsOpenedIds: (
    _viewerId: string | null | undefined,
    ids: string[],
    fallback?: ReadonlySet<string>,
  ) => {
    const next = new Set([...(fallback ?? []), ...ids]);
    smsOpenedState.ids = next;
    window.dispatchEvent(new CustomEvent("axis:manager-sms-opened-changed"));
    return next;
  },
  MANAGER_SMS_OPENED_CHANGED_EVENT: "axis:manager-sms-opened-changed",
}));
vi.mock("@/lib/manager-sms-hidden.client", () => ({
  loadSmsHiddenIds: () => new Set<string>(),
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
import { loadManagerSmsConversationsClient } from "@/lib/manager-sms-conversations-client";
import { WORKSPACE_SELECTION_EVENT } from "@/lib/workspaces/selection";
import { buildActiveCommunicationThreads, countUnreadActiveConversations } from "@/lib/communication-active-rows";
import type { ManagerSmsMessageRow, ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";

beforeEach(() => {
  inboxState.rows = [EMAIL_UNREAD, SMS_NOTICE_UNREAD, EMAIL_READ, SENT];
  smsArchiveState.archivedIds = new Set();
  smsConversationsState.residents = [];
  smsOpenedState.ids = new Set();
  workspaceState.id = null;
  vi.mocked(loadManagerSmsConversationsClient).mockClear();
});
afterEach(cleanup);

function inboundSmsMessage(id: string): ManagerSmsMessageRow {
  return {
    id,
    direction: "inbound",
    body: "hey",
    fromPhone: "+12065550100",
    toPhone: "+12065550199",
    messageSid: null,
    source: "work_number",
    createdAt: "2026-09-20T00:00:00.000Z",
  };
}

function smsResident(
  overrides: Partial<ManagerSmsResidentConversation> & { conversationKey: string; messages: ManagerSmsMessageRow[] },
): ManagerSmsResidentConversation {
  return {
    residentUserId: null,
    residentEmail: null,
    name: "Resident",
    phone: null,
    propertyLabel: null,
    ...overrides,
  };
}

describe("Communication nav badge counts what the conversation list shows", () => {
  it("counts an unread inbound-SMS notice for the resident badge", () => {
    const { result } = renderHook(() => usePortalNavCounts("resident"));
    // Unlike the manager list, the resident Active list never collapses
    // person rows, so the unread email and the unread SMS notice both count.
    expect(result.current.communication?.count).toBe(2);
    expect(result.current.communication?.tone).toBe("alert");
  });

  it("counts an unread inbound-SMS notice for the manager badge", () => {
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.communication?.count).toBe(1);
    expect(result.current.communication?.tone).toBe("alert");
  });

  it("does not count a leftover hidden assistant notice", () => {
    inboxState.rows = [LIVE_ASSISTANT_READ, LEFTOVER_ASSISTANT_UNREAD];
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.communication?.count).toBe(0);
  });

  it("recounts after a same-tab inbox change", () => {
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.communication?.count).toBe(1);
    inboxState.rows = [EMAIL_READ, LIVE_ASSISTANT_READ];
    act(() => {
      window.dispatchEvent(new CustomEvent(PORTAL_INBOX_CHANGED_EVENT, { detail: { key: "manager-inbox" } }));
    });
    expect(result.current.communication?.count).toBe(0);
  });

  // Regressions locking in the PLAN-0921-0001 fix — the badge used to build its
  // own row set instead of reusing the Active list's, and could disagree with
  // it in exactly these three ways.
  it("keeps an unresolved inbound-SMS notice actionable in either UI flag state", () => {
    inboxState.rows = [SMS_NOTICE_UNREAD];
    const { result: hidden } = renderHook(() => usePortalNavCounts("manager", true));
    expect(hidden.current.communication?.count).toBe(1);
    const { result: shown } = renderHook(() => usePortalNavCounts("manager", false));
    expect(shown.current.communication?.count).toBe(1);
  });

  it("matches the number of dotted rows the shared Active-rows builder returns", () => {
    const opts = { portal: "manager" as const, viewerId: "user-1", smsUiEnabled: false };
    const activeRows = buildActiveCommunicationThreads(
      inboxState.rows as Parameters<typeof buildActiveCommunicationThreads>[0],
      opts,
    );
    const dotted = activeRows.filter((t) => t.folder === "inbox" && t.unread).length;
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.communication?.count).toBe(dotted);
  });

  it("excludes an unread thread bound to an SMS conversation already archived in the SMS panel", () => {
    const boundThread = {
      ...EMAIL_UNREAD,
      id: "thr-1000000005",
      smsConversationKey: "sms-conv-1",
    };
    inboxState.rows = [boundThread];
    smsArchiveState.archivedIds = new Set(["sms-conv-1"]);
    const { result } = renderHook(() => usePortalNavCounts("manager"));
    expect(result.current.communication?.count).toBe(0);
  });
});

// PLAN-0921-0001 follow-up — the badge only read persisted email rows, so an
// unopened SMS conversation with no bound email thread stayed invisible in the
// sidebar even though the Active list showed its unread dot.
describe("Communication nav badge folds in SMS conversations in either UI flag state", () => {
  it("counts an unopened SMS conversation with no unread email as 1", async () => {
    inboxState.rows = [];
    smsConversationsState.residents = [
      smsResident({ conversationKey: "conv-1", name: "Jamie Resident", messages: [inboundSmsMessage("m1")] }),
    ];
    const { result } = renderHook(() => usePortalNavCounts("manager", true));
    await waitFor(() => expect(result.current.communication?.count).toBe(1));
    expect(result.current.communication?.tone).toBe("alert");
  });

  it("merges an unread email bound to the same SMS conversation into one row", async () => {
    inboxState.rows = [
      {
        id: "thr-bound-conv-1",
        folder: "inbox",
        from: "Jamie Resident",
        email: "jamie@example.com",
        subject: "Question",
        body: "hi",
        time: "Sep 20, 2026",
        unread: true,
        smsConversationKey: "conv-1",
      },
    ];
    smsConversationsState.residents = [
      smsResident({
        conversationKey: "conv-1",
        residentEmail: "jamie@example.com",
        name: "Jamie Resident",
        messages: [inboundSmsMessage("m2")],
      }),
    ];
    const { result } = renderHook(() => usePortalNavCounts("manager", true));
    // One merged conversation, not two — matches the Active list's own merge.
    await waitFor(() => expect(result.current.communication?.count).toBe(1));
  });

  it("recounts to 0 once the SMS message is marked opened", async () => {
    inboxState.rows = [];
    smsConversationsState.residents = [
      smsResident({ conversationKey: "conv-2", name: "Alex Resident", messages: [inboundSmsMessage("m3")] }),
    ];
    const { result } = renderHook(() => usePortalNavCounts("manager", true));
    await waitFor(() => expect(result.current.communication?.count).toBe(1));
    const { markManagerSmsOpenedIds } = await import("@/lib/manager-sms-opened.client");
    act(() => {
      markManagerSmsOpenedIds("user-1", ["m3"], new Set());
    });
    await waitFor(() => expect(result.current.communication?.count).toBe(0));
  });

  it("counts server-unread projection SMS when chrome is off even if the latest preview is outbound", async () => {
    inboxState.rows = [];
    smsConversationsState.residents = [
      smsResident({ projectionId: "opaque-3", conversationKey: "conv-3", name: "Sam Resident", unread: true,
        messages: [{ ...inboundSmsMessage("m4"), direction: "outbound" }] }),
    ];
    const { result } = renderHook(() => usePortalNavCounts("manager", false));
    await waitFor(() => expect(result.current.communication?.count).toBe(1));
    expect(loadManagerSmsConversationsClient).toHaveBeenCalledWith("user-1", false, null);
  });

  it("reloads the badge in the selected workspace without showing the previous workspace's SMS count", async () => {
    inboxState.rows = [];
    workspaceState.id = "workspace-a";
    smsConversationsState.residents = [smsResident({ projectionId: "opaque-a", conversationKey: "conv-a", name: "A", unread: true,
      messages: [inboundSmsMessage("ma")] })];
    const { result } = renderHook(() => usePortalNavCounts("manager", false));
    await waitFor(() => expect(result.current.communication?.count).toBe(1));
    expect(loadManagerSmsConversationsClient).toHaveBeenCalledWith("user-1", false, "workspace-a");
    workspaceState.id = "workspace-b";
    smsConversationsState.residents = [];
    act(() => window.dispatchEvent(new Event(WORKSPACE_SELECTION_EVENT)));
    await waitFor(() => expect(loadManagerSmsConversationsClient).toHaveBeenCalledWith("user-1", false, "workspace-b"));
    await waitFor(() => expect(result.current.communication?.count).toBe(0));
  });
});

describe("countUnreadActiveConversations (pure)", () => {
  const baseOpts = { portal: "manager" as const, viewerId: "user-1", smsUiEnabled: true };

  it("skips a hidden SMS conversation and an archived one, counting only the visible one", () => {
    const residents = [
      smsResident({ conversationKey: "hidden-1", name: "Hidden", messages: [inboundSmsMessage("h1")] }),
      smsResident({ conversationKey: "archived-1", name: "Archived", messages: [inboundSmsMessage("a1")] }),
      smsResident({ conversationKey: "visible-1", name: "Visible", messages: [inboundSmsMessage("v1")] }),
    ];
    const count = countUnreadActiveConversations([], {
      ...baseOpts,
      smsConversations: residents,
      smsHiddenIds: new Set(["hidden-1"]),
      smsArchivedIds: new Set(["archived-1"]),
      smsOpenedIds: new Set(),
    });
    expect(count).toBe(1);
  });

  it("counts SMS conversations when smsUiEnabled is false", () => {
    const residents = [
      smsResident({ conversationKey: "conv-1", name: "Jamie", messages: [inboundSmsMessage("m1")] }),
    ];
    const count = countUnreadActiveConversations([], {
      ...baseOpts,
      smsUiEnabled: false,
      smsConversations: residents,
    });
    expect(count).toBe(1);
  });
});
