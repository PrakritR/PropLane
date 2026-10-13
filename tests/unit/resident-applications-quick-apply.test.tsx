// @vitest-environment jsdom
/**
 * Resident Applications: with saved answers, the round blue + opens Quick apply instead of the plain picker.
 * The sheet starts on a listing picker, then asks for the room, the move-in, the two confirmations and the
 * typed signature, and one Submit posts to /api/portal/quick-apply and opens the new application.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";

let ROWS: DemoApplicantRow[] = [];
let searchParams = new URLSearchParams();
const mocks = vi.hoisted(() => ({ feeCharge: null as null | { amountLabel: string; status: string } }));
const nav = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/applications",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => searchParams,
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => nav.navigate }));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ email: "jamie.rivera@example.com", userId: "u1", ready: true }),
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
  readExtraListingsPublic: () => [{ id: "prop-1", title: "5257 Brooklyn Ave", adminPublishLive: true }],
}));
vi.mock("@/lib/public-sandbox-listings", () => ({ filterSandboxFromPublicCatalog: (list: unknown[]) => list }));
vi.mock("@/lib/public-demo-access", () => ({ isProductionPublicSite: () => false }));
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: (id: string) =>
    id === "prop-1"
      ? { id: "prop-1", title: "5257 Brooklyn Ave", address: "5257 Brooklyn Ave", listingSubmission: { v: 1, rooms: [{ id: "r1", name: "Room 1" }, { id: "r2", name: "Room 2" }] } }
      : undefined,
  propertyAllowsShortTermRental: () => false,
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
vi.mock("@/lib/household-charges", () => ({
  findApplicationFeeCharge: () => mocks.feeCharge,
}));

vi.mock("@/hooks/use-quick-apply-eligibility", () => ({
  useQuickApplyProfile: () => ({ ready: true, hasProfile: true }),
  resetQuickApplyReadiness: () => {},
}));

import { ResidentApplicationsPanel } from "@/components/portal/resident-applications-panel";

beforeEach(() => nav.navigate.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  ROWS = [];
  searchParams = new URLSearchParams();
});

describe("ResidentApplicationsPanel - Quick apply sheet", () => {
  it("opens from the round blue + on a listing picker, then asks for room, confirmation and signature", async () => {
    await act(async () => {
      render(<ResidentApplicationsPanel />);
    });
    fireEvent.click(document.querySelector('[data-attr="resident-applications-apply"]')!);
    // The plain picker's "Start application" is not what opens: this is Quick apply, picker first.
    expect(screen.getByText("Quick apply")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start application" })).toBeNull();
    fireEvent.click((await screen.findAllByText("5257 Brooklyn Ave"))[0]!);

    const submit = await screen.findByRole("button", { name: "Submit" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Full application" })).toBeTruthy();
    fireEvent.click(document.querySelector('[data-attr="quick-apply-confirm-current"]')!);
    fireEvent.change(screen.getByLabelText("Signature"), { target: { value: "Jamie Rivera" } });
    // Two rooms: one has to be picked first.
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it("posts the confirmation and signature for a single-room listing and navigates to the application", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true, applicationId: "PROPLANE-ABCD1234", href: "/resident/applications/pending/PROPLANE-ABCD1234" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await act(async () => {
      render(<ResidentApplicationsPanel />);
    });
    fireEvent.click(document.querySelector('[data-attr="resident-applications-apply"]')!);
    fireEvent.click((await screen.findAllByText("5257 Brooklyn Ave"))[0]!);
    // Pick Room 1 through the shared dropdown (a trigger + listbox, not a native select).
    const trigger = (await screen.findAllByLabelText("Room"))[0]!;
    fireEvent.click(trigger);
    const option = document.getElementById(trigger.getAttribute("aria-controls")!)!.querySelector('[data-field-select-option-value="r1"]')!;
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
    // The standard application asks for screening consent: the sheet shows it as its first box.
    fireEvent.click(document.querySelector('[data-attr="quick-apply-consent-screening"]')!);
    fireEvent.click(document.querySelector('[data-attr="quick-apply-confirm-current"]')!);
    fireEvent.change(screen.getByLabelText("Signature"), { target: { value: "Jamie Rivera" } });
    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith("/resident/applications/pending/PROPLANE-ABCD1234"));
    const call = (fetchSpy.mock.calls as unknown[][]).find((c) => String(c[0]).includes("/api/portal/quick-apply"))!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body).toMatchObject({ propertyId: "prop-1", roomId: "r1", consentCredit: true, confirmCurrent: true, signature: "Jamie Rivera" });
  });
});
