// @vitest-environment jsdom
//
// C1-R4: the resident's conversation list names each row's server-stamped
// counterparty (not a client-side email match), and shows ONE compact
// "Verify your number" row when their phone is unverified or ambiguous.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

const ROW = {
  id: "res-thr-1000000001",
  folder: "inbox",
  from: "someone@else.example",
  email: "someone@else.example",
  subject: "Welcome",
  preview: "Keys are ready",
  body: "Keys are ready",
  time: "Jul 20, 2026",
  unread: false,
  conversationKey: "ws:ws-1",
  counterparty: {
    workspaceId: "ws-1",
    name: "Dana Whitfield",
    workspaceName: "Cascade Lofts Management",
    workPhone: "+15103098345",
    avatarUrl: null,
    initials: "DW",
  },
};

const phone = vi.hoisted(() => ({ state: null as null | { hasPhone: boolean; verified: boolean; ambiguous: boolean } }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/communication/active",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("@/lib/portal-inbox-storage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/portal-inbox-storage")>("@/lib/portal-inbox-storage");
  return {
    ...actual,
    RESIDENT_INBOX_STORAGE_KEY: "resident-inbox",
    loadPersistedInbox: () => [ROW],
    syncPersistedInboxFromServerWithStatus: () => Promise.resolve({ rows: [ROW], ok: true }),
    residentPhoneStateFor: () => phone.state,
    inboxThreadMessages: (t: { id: string; from: string; body: string; time: string }) => [
      { id: `${t.id}-root`, from: t.from, body: t.body, at: t.time },
    ],
  };
});
vi.mock("@/components/portal/resident-inbox-panel", () => ({
  ResidentInboxPanel: () => <div data-testid="resident-thread" />,
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "resident-test", email: "resident@example.com", ready: true }),
}));
vi.mock("@/hooks/use-resident-manager-contacts", () => ({ useResidentManagerContacts: () => [] }));
vi.mock("@/components/portal/role-sms-panel", () => ({ RoleSmsPanel: () => <div /> }));

import { ResidentCommunication } from "@/components/portal/resident-communication";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  phone.state = null;
});

function mount() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  render(<ResidentCommunication />);
}

describe("resident conversation list identity", () => {
  it("names the row with the stamped counterparty, not the thread email", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Dana Whitfield")).toBeTruthy());
    expect(screen.queryByText("someone@else.example", { selector: "p, span" })).toBeNull();
  });

  it.each([
    ["unverified", { hasPhone: true, verified: false, ambiguous: false }],
    ["ambiguous", { hasPhone: true, verified: true, ambiguous: true }],
  ])("shows one Verify your number row when the phone is %s", async (_label, state) => {
    phone.state = state;
    mount();
    const link = await screen.findByText("Verify your number");
    expect(link.closest("a")?.getAttribute("href")).toBe("/resident/profile?tab=messaging");
    expect(screen.getAllByText("Verify your number")).toHaveLength(1);
  });

  it.each([
    ["verified", { hasPhone: true, verified: true, ambiguous: false }],
    ["no phone", { hasPhone: false, verified: false, ambiguous: false }],
    ["unknown", null],
  ])("shows no prompt when the phone is %s", async (_label, state) => {
    phone.state = state;
    mount();
    await waitFor(() => expect(screen.getByText("Dana Whitfield")).toBeTruthy());
    expect(screen.queryByText("Verify your number")).toBeNull();
  });
});
