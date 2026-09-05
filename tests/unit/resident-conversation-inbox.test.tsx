// @vitest-environment jsdom
//
// Resident Communication matches the manager CRM layout: Active / Unread / Archived
// segments, unified conversation list, and Archive (not Trash).
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

const EMAIL_INBOX = {
  id: "res-thr-1000000001",
  folder: "inbox",
  from: "Property manager",
  email: "manager@example.com",
  subject: "Welcome to your unit",
  preview: "Here is your move-in info",
  body: "Here is your move-in info",
  time: "Jul 20, 2026",
  unread: true,
};
const EMAIL_ARCHIVED = {
  id: "res-thr-1000000002",
  folder: "trash",
  from: "Old notice",
  email: "old@example.com",
  subject: "Old",
  preview: "old",
  body: "old",
  time: "Jul 01, 2026",
  unread: false,
};

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/communication/active",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => vi.fn(),
}));

vi.mock("@/lib/portal-inbox-storage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/portal-inbox-storage")>(
    "@/lib/portal-inbox-storage",
  );
  return {
    ...actual,
    PORTAL_INBOX_CHANGED_EVENT: "portal-inbox-changed",
    RESIDENT_INBOX_STORAGE_KEY: "resident-inbox",
    inboxThreadSortMs: actual.inboxThreadSortMs,
    loadPersistedInbox: () => [EMAIL_INBOX, EMAIL_ARCHIVED],
    inboxThreadMessages: (t: { id: string; from: string; body: string; time: string }) => [
      { id: `${t.id}-root`, from: t.from, body: t.body, at: t.time },
    ],
  };
});
vi.mock("@/components/portal/resident-inbox-panel", () => ({
  ResidentInboxPanel: () => <div data-testid="resident-thread" />,
}));
vi.mock("@/components/portal/role-sms-panel", () => ({ RoleSmsPanel: () => <div data-testid="role-sms" /> }));

import { ResidentCommunication } from "@/components/portal/resident-communication";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("resident conversation inbox", () => {
    it("shows Active and Archived segments like the property portal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    render(<ResidentCommunication />);

    expect(screen.getByRole("link", { name: /^Active$/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Archived/i })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Unread/i })).toBeNull();
    await waitFor(() => expect(screen.getByText("Property manager")).toBeTruthy());
    expect(screen.queryByText("Old notice")).toBeNull();
  });

  it("lists archived conversations on the Archived segment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    render(<ResidentCommunication listSegment="archived" />);
    await waitFor(() => expect(screen.getByText("Old notice")).toBeTruthy());
    expect(screen.queryByText("Property manager")).toBeNull();
  });

  it("does not offer Set up messaging on resident Communication", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    render(<ResidentCommunication />);
    expect(screen.queryByRole("button", { name: /set up messaging/i })).toBeNull();
    expect(screen.queryByText("Set up messaging")).toBeNull();
    expect(screen.getByRole("button", { name: /new message/i })).toBeTruthy();
  });

  it("does not fetch SMS when the SMS UI flag is off (default)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ResidentCommunication />);
    await waitFor(() => expect(screen.getByText("Property manager")).toBeTruthy());
    const calledSms = fetchMock.mock.calls.some(([url]) => String(url).includes("/api/resident/sms-conversations"));
    expect(calledSms).toBe(false);
  });
});
