// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  demo: false,
  deleteResult: { ok: true } as { ok: boolean; error?: string },
  deleteInquiry: vi.fn(),
  declineLocal: vi.fn((id: string) => {
    void id;
    return true;
  }),
  sync: vi.fn(async (opts?: { force?: boolean }) => {
    void opts;
    return true;
  }),
  toast: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/events",
  useSearchParams: () => new URLSearchParams("tab=pending"),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: state.toast }) }));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "admin-1", email: "admin@example.test" }),
}));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => state.demo, DEMO_MANAGER_USER_ID: "demo-manager" }));
vi.mock("@/lib/demo-admin-scheduling", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-admin-scheduling")>()),
  ADMIN_AVAILABILITY_STORAGE_KEY: "availability",
  adminAvailabilityStorageKey: () => "availability-admin-1",
  readPartnerInquiries: () => [{
    id: "tour-inquiry-1",
    kind: "tour",
    status: "pending",
    name: "Ava Prospect",
    email: "ava@example.test",
    phone: "+15550000001",
    notes: "",
    proposedStart: "2030-01-01T18:00:00.000Z",
    proposedEnd: "2030-01-01T18:30:00.000Z",
    createdAt: "2030-01-01T00:00:00.000Z",
  }],
  readPlannedEvents: () => [],
  syncScheduleRecordsFromServer: (opts?: { force?: boolean }) => state.sync(opts),
  acceptPartnerInquiryFromServer: vi.fn(async () => ({ ok: true })),
  deletePartnerInquiryFromServer: (id: string, opts?: { notifyTenant?: boolean }) => state.deleteInquiry(id, opts),
  declinePartnerInquiry: (id: string) => state.declineLocal(id),
}));

import { AdminEventsClient } from "@/components/portal/admin-events-client";

async function declineSelectedInquiry() {
  render(<AdminEventsClient />);
  fireEvent.keyDown(
    await screen.findByRole("button", { name: /Actions for Ava Prospect/ }),
    { key: "ArrowDown" },
  );
  const decline = await screen.findByRole("menuitem", { name: "Decline" });
  await new Promise((resolve) => setTimeout(resolve, 160));
  fireEvent.click(decline);
}

beforeEach(() => {
  state.demo = false;
  state.deleteResult = { ok: true };
  state.deleteInquiry.mockReset().mockImplementation(async () => state.deleteResult);
  state.declineLocal.mockReset().mockReturnValue(true);
  state.sync.mockClear();
  state.toast.mockClear();
});

afterEach(cleanup);

describe("AdminEventsClient decline", () => {
  it("awaits the real tour decline route before reporting success", async () => {
    await declineSelectedInquiry();

    await waitFor(() => expect(state.deleteInquiry).toHaveBeenCalledWith(
      "tour-inquiry-1",
      { notifyTenant: false },
    ));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith("Request declined."));
    expect(state.declineLocal).not.toHaveBeenCalled();
  });

  it("reports route failure and never shows a false success toast", async () => {
    state.deleteResult = { ok: false, error: "Forbidden." };
    await declineSelectedInquiry();

    await waitFor(() => expect(state.toast).toHaveBeenCalledWith("Could not update these requests."));
    expect(state.toast).not.toHaveBeenCalledWith("Request declined.");
    expect(state.declineLocal).not.toHaveBeenCalled();
  });

  it("keeps demo decline local", async () => {
    state.demo = true;
    await declineSelectedInquiry();

    await waitFor(() => expect(state.declineLocal).toHaveBeenCalledWith("tour-inquiry-1"));
    expect(state.deleteInquiry).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith("Request declined.");
  });
});
