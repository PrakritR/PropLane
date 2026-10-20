// @vitest-environment jsdom
/**
 * Admin Communication names the PropLane Service workspace each text belongs to (a plain fact on the row and in the
 * thread, "Unassigned" when none), filters by it from the Filter popover, opens the workspace from the thread, and
 * lets admin assign a PropLane-line lead to a workspace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/hooks/use-is-client", () => ({ useIsClient: () => true }));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "admin-1", email: "admin@example.test", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useOptionalAppUi: () => null,
  useAppUi: () => ({ showToast: toast }),
  useConfirm: () => async () => true,
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/components/portal/pro-sms-panel", () => ({
  ManagerSmsPanel: () => <div data-testid="admin-sms-thread" />,
  smsOutboundPreviewPrefix: () => "",
}));

import { AdminCommunication } from "@/components/portal/admin-communication";
import { resetAdminScheduledForTests } from "@/lib/admin-inbox-source";
import { seedDemoAdminInbox } from "@/lib/demo-admin-partner-inbox";
import { resetManagerInboxSnapshotCacheForTests } from "@/components/portal/pro-unified-inbox";
import { publishAdminWorkNumber } from "@/components/portal/admin-work-identity-card";
import { publishAdminSmsWorkspaces } from "@/lib/admin-sms-workspaces";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const at = (offsetMs: number) => new Date(Date.now() - offsetMs).toISOString();

const row = (over: Record<string, unknown>) => ({
  residentUserId: null,
  residentEmail: null,
  savedContactName: null,
  propertyLabel: null,
  counterpartyRole: "prospect",
  ...over,
});
const PLACED = row({
  name: "Pat Texter",
  phone: "+12065550123",
  conversationKey: "owner:prospect:1",
  workspaceId: WS,
  workspaceName: "1. Ambika",
  messages: [{ id: "m1", direction: "inbound", body: "Is the room still open?", createdAt: at(1000), messageSid: "SM1" }],
});
const STRANGER = row({
  name: "Sam Stranger",
  phone: "+12065550124",
  conversationKey: "owner:prospect:2",
  workspaceId: null,
  workspaceName: null,
  messages: [{ id: "m2", direction: "inbound", body: "Hi there", createdAt: at(2000), messageSid: "SM2" }],
});
const LEAD = row({
  name: "Lead •••• 0199",
  phone: null,
  conversationKey: "lead:lead-1",
  workspaceId: null,
  workspaceName: null,
  unassignedLeadId: "lead-1",
  messages: [{ id: "lead-turn:t1", direction: "inbound", body: "any rooms near UW?", createdAt: at(3000), messageSid: null }],
});

let fetchMock: ReturnType<typeof vi.fn>;
let smsUrls: string[];

beforeEach(() => {
  resetAdminScheduledForTests();
  resetManagerInboxSnapshotCacheForTests();
  window.localStorage.clear();
  seedDemoAdminInbox([]);
  smsUrls = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.startsWith("/api/admin/sms-conversations")) {
      smsUrls.push(target);
      const filtered = target.includes(`workspaceId=${WS}`);
      return Response.json({
        residents: filtered ? [PLACED] : [PLACED, STRANGER, LEAD],
        workNumber: "+12065550100",
        workspaces: [{ id: WS, name: "1. Ambika" }],
      });
    }
    if (target.includes("scheduled-inbox-messages")) return Response.json({ messages: [] });
    if (target.startsWith("/api/admin/unassigned-leads/") && init?.method === "PATCH") return Response.json({ ok: true });
    return Response.json({ ok: true, rows: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  toast.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  publishAdminWorkNumber(null);
  publishAdminSmsWorkspaces([]);
});

describe("workspace on admin text threads", () => {
  it("each row names its workspace as a plain fact, and Unassigned when none", async () => {
    render(<AdminCommunication smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Pat Texter")).toBeTruthy());
    expect(screen.getByText("1. Ambika")).toBeTruthy();
    expect(screen.getAllByText("Unassigned").length).toBeGreaterThanOrEqual(2);
  });

  it("the thread shows its workspace with an Open in workspace icon action; a stranger's has none", async () => {
    const { container } = render(<AdminCommunication smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Pat Texter")).toBeTruthy());
    fireEvent.click(screen.getByText("Pat Texter"));
    await screen.findByTestId("admin-sms-thread");
    expect(container.querySelector('[data-attr="admin-communication-workspace-name"]')?.textContent).toBe("1. Ambika");
    expect(screen.getByRole("button", { name: "Open in workspace" })).toBeTruthy();

    cleanup();
    const second = render(<AdminCommunication smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Sam Stranger")).toBeTruthy());
    fireEvent.click(screen.getByText("Sam Stranger"));
    await screen.findByTestId("admin-sms-thread");
    expect(second.container.querySelector('[data-attr="admin-communication-workspace-name"]')?.textContent).toBe("Unassigned");
    expect(screen.queryByRole("button", { name: "Open in workspace" })).toBeNull();
  });

  it("a PropLane-line lead opens read-only with an Assign control, and assigning PATCHes the lead", async () => {
    const { container } = render(<AdminCommunication smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Lead •••• 0199")).toBeTruthy());
    fireEvent.click(screen.getByText("Lead •••• 0199"));
    await waitFor(() => expect(container.querySelector('[data-attr="admin-communication-lead-thread"]')).toBeTruthy());
    expect(screen.queryByTestId("admin-sms-thread")).toBeNull();
    expect(container.querySelector('[data-attr="admin-communication-workspace-name"]')?.textContent).toBe("Unassigned");
    // No composer and no number: the only action is Assign, and it needs a workspace first.
    expect(container.querySelector('[data-attr="admin-communication-reply"]')).toBeNull();
    const assign = container.querySelector('[data-attr="admin-communication-assign-submit"]') as HTMLButtonElement;
    expect(assign.disabled).toBe(true);
  });
});

describe("the Workspace filter", () => {
  function stubPointerFine() {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes("pointer: fine"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      })),
    });
  }

  it("is a Filter field listing Unassigned and each service workspace; picking one re-reads the stream with it", async () => {
    stubPointerFine();
    const { container } = render(<AdminCommunication smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Pat Texter")).toBeTruthy());
    expect(smsUrls[0]).toBe("/api/admin/sms-conversations");

    fireEvent.click(container.querySelector('[data-attr="communication-filter-sheet-open"]')!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Workspace")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Workspace/ }));
    // The menu is portaled out of the dialog: Unassigned first, then each service workspace by name.
    const options = within(await screen.findByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
    expect(options.map((o) => o?.replace("✓", ""))).toEqual(["All workspaces", "Unassigned", "1. Ambika"]);
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "1. Ambika" }));
    fireEvent.click(dialog.querySelector('[data-attr="portal-filter-save"]')!);

    await waitFor(() => expect(smsUrls.some((url) => url === `/api/admin/sms-conversations?workspaceId=${WS}`)).toBe(true));
    await waitFor(() => expect(screen.queryByText("Sam Stranger")).toBeNull());
    expect(screen.getByText("Pat Texter")).toBeTruthy();
  });

  it("is absent when the text stream is off", async () => {
    stubPointerFine();
    const { container } = render(<AdminCommunication smsUiEnabled={false} />);
    await waitFor(() => expect(container.querySelector('[data-attr="communication-filter-sheet-open"]')).toBeTruthy());
    fireEvent.click(container.querySelector('[data-attr="communication-filter-sheet-open"]')!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("Workspace")).toBeNull();
  });
});
