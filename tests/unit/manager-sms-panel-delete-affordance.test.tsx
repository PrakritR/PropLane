// @vitest-environment jsdom
//
// `ManagerSmsPanel` is mounted on the manager Communication tab, the resident
// detail page AND the new admin oversight tab, but only the manager route
// implements DELETE. Rendering the swipe/trash affordances unconditionally
// meant admin got a destructive confirm dialog followed by a 405 that
// `res.json().catch(() => ({}))` swallowed into a generic "Could not delete
// conversation." — every single time. A button that can only ever fail is
// worse than no button, so delete is opt-in per surface.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: (msg: string) => showToast(msg) }),
}));
vi.mock("@/components/portal/manager-sms-compose-modal", () => ({
  ManagerSmsComposeModal: () => null,
}));

import { ManagerSmsPanel } from "@/components/portal/manager-sms-panel";

const PAYLOAD = {
  workNumber: "+12065550999",
  personalPhone: null,
  phoneVerified: false,
  forwardInbound: true,
  smsConfigured: true,
  residents: [
    {
      residentUserId: "res-1",
      residentEmail: "jane@example.com",
      name: "Jane Resident",
      phone: "+12065550100",
      propertyLabel: "Unit A",
      tenancyStatus: "resident" as const,
      counterpartyRole: "resident" as const,
      conversationKey: "mgr-1:resident:res-1",
      ownerManagerUserId: "mgr-1",
      messages: [
        {
          id: "m1",
          direction: "inbound" as const,
          body: "hi it's Jane",
          fromPhone: "+12065550100",
          toPhone: "+12065550999",
          messageSid: "SM1",
          source: "work_number" as const,
          createdAt: "2026-07-20T00:00:00.000Z",
          storageTable: "inbound_sms_log" as const,
        },
      ],
    },
  ],
};

beforeEach(() => {
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(PAYLOAD), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  showToast.mockClear();
  vi.unstubAllGlobals();
});

describe("ManagerSmsPanel delete affordance", () => {
  it("offers delete on the manager endpoint, which implements DELETE", async () => {
    render(<ManagerSmsPanel />);
    await waitFor(() => expect(screen.getByText("Jane Resident")).toBeTruthy());
    expect(screen.queryAllByText("Delete").length).toBeGreaterThan(0);
  });

  it("hides every delete control when the surface cannot delete (admin oversight)", async () => {
    render(<ManagerSmsPanel endpoint="/api/admin/sms-conversations" allowDelete={false} />);
    await waitFor(() => expect(screen.getByText("Jane Resident")).toBeTruthy());
    expect(screen.queryAllByText("Delete")).toEqual([]);
    expect(screen.queryByLabelText("Delete conversation")).toBeNull();
    expect(screen.queryByLabelText("Delete message")).toBeNull();
  });

  // Deleting a single text is gone from every surface: the transport record is
  // the evidence of what was actually sent, and a per-bubble trash icon beside
  // every message was mostly a misclick risk. Conversation-level delete stays.
  it("offers no per-message delete once a thread is open", async () => {
    render(<ManagerSmsPanel />);
    await waitFor(() => expect(screen.getByText("Jane Resident")).toBeTruthy());
    screen.getByText("Jane Resident").click();
    await waitFor(() => expect(screen.getByText("hi it's Jane")).toBeTruthy());
    expect(screen.queryByLabelText("Delete message")).toBeNull();
  });
});
