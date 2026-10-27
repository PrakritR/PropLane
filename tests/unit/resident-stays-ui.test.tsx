// @vitest-environment jsdom
/**
 * Render-level proof that a guest's short stays are rows on the resident Application page (captain, Oct 27: no
 * Stays tab, "same UI for both short term and long term"): pending -> Sent, confirmed -> Approved (Pay now while
 * unpaid), declined / expired / cancelled -> Denied; the same row look as an application (house · room, "Short
 * stay · dates · nights", the amount, the per-row ⋯, no pill); the round + offers Long-term lease or Short stay;
 * a list that cannot load shows its error and Try again. The request form itself is `resident-stay-request-ui`.
 * The network client is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { GuestStay } from "@/lib/short-stay/guest-stays";

let ROWS: DemoApplicantRow[] = [];
const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/applications/pending",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => nav.navigate }));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ email: "priya@example.com", userId: "u1", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: () => {} }),
  useOptionalAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  syncManagerApplicationsFromServer: () => Promise.resolve(),
  readManagerApplicationRows: () => ROWS,
  replaceManagerApplicationRowInCache: () => {},
  cancelPendingApplicationRowUpsert: () => {},
  normalizeApplicationAxisId: (id: string) => id,
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/lib/resident-public-nav", () => ({ residentBrowseFromApplicationHref: () => "/rent/browse" }));
vi.mock("@/lib/demo-property-pipeline", () => ({
  isPropertyActiveForLeads: () => true,
  loadPublicExtraListingsFromServer: () => Promise.resolve([]),
  loadPublicPropertyLeadFromServer: () => Promise.resolve(undefined),
  readExtraListingsPublic: () => [
    { id: "prop-1", title: "Cedar Court", adminPublishLive: true },
    { id: "prop-2", title: "Long-term only", adminPublishLive: true },
  ],
}));
vi.mock("@/lib/public-sandbox-listings", () => ({ filterSandboxFromPublicCatalog: (list: unknown[]) => list }));
vi.mock("@/lib/public-demo-access", () => ({ isProductionPublicSite: () => false }));
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: (id: string) => (id === "prop-1" ? { id: "prop-1", title: "Cedar Court", address: "12 Cedar Ct" } : id === "prop-2" ? { id: "prop-2", title: "Long-term only", address: "9 Elm" } : undefined),
  propertyAllowsShortTermRental: (id: string) => id === "prop-1",
  getRoomChoiceLabel: (value: string) => value,
  parseRoomChoiceValue: (value: string) => ({ listingRoomId: value.split("::")[1] ?? value }),
}));
vi.mock("@/components/portal/pro-applications", () => ({
  applicationPdfHref: () => "/api/manager-applications/test/pdf?disposition=inline",
  ApplicationDocumentPreview: () => null,
}));
vi.mock("@/components/portal/resident-application-editor", () => ({ ResidentApplicationEditor: () => null }));
vi.mock("@/components/marketing/rental-application-finish-panel", () => ({ GroupShareCallout: () => null }));
vi.mock("@/components/marketing/rental-application-wizard", () => ({ RentalApplicationWizard: () => null }));
vi.mock("@/lib/household-charges", () => ({ findApplicationFeeCharge: () => null }));
vi.mock("@/hooks/use-quick-apply-eligibility", () => ({
  useQuickApplyProfile: () => ({ ready: true, hasProfile: false }),
  resetQuickApplyReadiness: () => {},
}));
vi.mock("@/lib/room-availability-range", async (orig) => ({ ...(await orig<typeof import("@/lib/room-availability-range")>()), pacificTodayKey: () => "2026-10-14" }));

const client = vi.hoisted(() => ({ fetchGuestStays: vi.fn() }));
vi.mock("@/lib/short-stay/guest-stays-client", async (orig) => ({ ...(await orig<typeof import("@/lib/short-stay/guest-stays-client")>()), ...client }));

import { ResidentApplicationsPanel } from "@/components/portal/resident-applications-panel";

const base: GuestStay = {
  id: "s1", propertyId: "prop-1", roomId: "r1", propertyLabel: "Cedar Court", roomLabel: "Attic Nook",
  checkIn: "2026-10-20", checkOut: "2026-10-23", nights: 3, guests: 1, status: "confirmed", holdExpiresAt: null, total: 420, nightly: 140, canBookAgain: true,
};
const confirmed = base;
const pending: GuestStay = { ...base, id: "s2", roomLabel: "Garden Suite", roomId: "r4", checkIn: "2026-10-26", checkOut: "2026-10-27", nights: 1, status: "pending", holdExpiresAt: "2026-10-15T18:00:00Z", total: 140 };
const declined: GuestStay = { ...base, id: "s3", status: "declined", checkIn: "2026-10-28", checkOut: "2026-10-30", nights: 2, total: 280 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T20:00:00Z"));
  nav.navigate.mockReset();
  client.fetchGuestStays.mockReset();
  client.fetchGuestStays.mockResolvedValue([confirmed, pending, declined]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  ROWS = [];
});

async function mount() {
  await act(async () => {
    render(<ResidentApplicationsPanel />);
  });
}
const tab = (id: string) => document.querySelector(`[data-attr="resident-applications-section-${id}"]`) as HTMLElement;
const stayRows = () => [...document.querySelectorAll('[data-attr="resident-stay-row"]')] as HTMLElement[];

describe("short stays inside the Application page", () => {
  it("counts a requested stay in Sent, a confirmed one in Approved and a declined one in Denied", async () => {
    await mount();
    await waitFor(() => expect(tab("sent").textContent).toContain("1"));
    expect(tab("approved").textContent).toContain("1");
    expect(tab("denied").textContent).toContain("1");
    // There is no Stays tab or nav row on this page.
    expect(document.body.textContent).not.toMatch(/\bStays\b/);
  });

  it("Sent shows the request as an application row: house · room, Short stay · dates · nights, the amount, no pill", async () => {
    await mount();
    await waitFor(() => expect(stayRows()).toHaveLength(1));
    const row = stayRows()[0]!;
    expect(row.textContent).toContain("Cedar Court · Garden Suite");
    expect(row.textContent).toContain("Short stay · Oct 26–27 · 1 night");
    expect(row.textContent).toContain("Requested, expires in 22h");
    expect(row.textContent).toContain("$140");
    expect(row.querySelector('[class*="rounded-full"][class*="bg-"]')).toBeNull();
    expect(row.textContent).not.toContain("Pay now");
  });

  it("Approved shows the confirmed stay; while unpaid its menu offers Pay now, Check-in times and Request again", async () => {
    client.fetchGuestStays.mockResolvedValue([{ ...confirmed, payment: "due" }]);
    await mount();
    // Sent is empty, so the page opens on Approved.
    await waitFor(() => expect(stayRows()).toHaveLength(1));
    expect(tab("approved").textContent).toContain("1");
    const row = stayRows()[0]!.closest("[data-record-row]") as HTMLElement;
    expect(row.textContent).toContain("Approved, pay now");
    expect(row.textContent).toContain("Short stay · Oct 20–23 · 3 nights");
    fireEvent.keyDown(row.querySelector('[data-attr="record-actions-trigger"]')!, { key: "ArrowDown" });
    expect(await screen.findByRole("menuitem", { name: /Pay now/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Check-in times/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Request again/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /Pay now/ }));
    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith("/resident/payments/pending"));
  });

  it("Denied shows declined stays; Request again opens the request form with the house and room prefilled", async () => {
    client.fetchGuestStays.mockResolvedValue([declined]);
    await mount();
    await waitFor(() => expect(stayRows()).toHaveLength(1));
    const row = stayRows()[0]!.closest("[data-record-row]") as HTMLElement;
    expect(row.textContent).toContain("Declined");
    fireEvent.keyDown(row.querySelector('[data-attr="record-actions-trigger"]')!, { key: "ArrowDown" });
    expect(screen.queryByRole("menuitem", { name: /Pay now/ })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Request again/ }));
    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith("/resident/applications/stay?listing=prop-1&room=r1&guests=1"));
  });

  it("an empty section says so and offers its sibling, not a blank page", async () => {
    client.fetchGuestStays.mockResolvedValue([declined]);
    await mount();
    await waitFor(() => expect(stayRows()).toHaveLength(1));
    fireEvent.click(tab("sent"));
    expect(await screen.findByText("Nothing sent")).toBeTruthy();
    expect(stayRows()).toHaveLength(0);
  });

  it("the round + offers Long-term lease or Short stay; Short stay lists only homes that take short stays, then opens the request form", async () => {
    await mount();
    const trigger = document.querySelector('[data-attr="resident-applications-apply"]')!;
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerId: 1 });
    expect(await screen.findByRole("menuitem", { name: "Long-term lease" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Short stay" }));
    expect(await screen.findByText("Request a short stay")).toBeTruthy();
    expect(screen.queryByText("Long-term only")).toBeNull();
    fireEvent.click((await screen.findAllByText("Cedar Court"))[0]!);
    fireEvent.click(document.querySelector('[data-attr="resident-applications-start"]')!);
    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith("/resident/applications/stay?listing=prop-1"));
  });

  it("a list that cannot load shows an error with Try again, and Try again asks again", async () => {
    client.fetchGuestStays.mockRejectedValueOnce(new Error("boom"));
    await mount();
    expect(await screen.findByText("Couldn't load your short stays")).toBeTruthy();
    client.fetchGuestStays.mockResolvedValue([pending]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    await waitFor(() => expect(stayRows()).toHaveLength(1));
    expect(client.fetchGuestStays).toHaveBeenCalledTimes(2);
  });
});
