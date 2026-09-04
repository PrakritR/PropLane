// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";

let ROWS: DemoApplicantRow[] = [];
const portalNavigate = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/applications/pending/PROPLANE-AAAA0001",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ email: "jamie.rivera@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => portalNavigate,
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  syncManagerApplicationsFromServer: () => Promise.resolve(),
  readManagerApplicationRows: () => ROWS,
  replaceManagerApplicationRowInCache: vi.fn(),
  cancelPendingApplicationRowUpsert: vi.fn(),
  normalizeApplicationAxisId: (id: string) => id,
}));
vi.mock("@/lib/rental-application/drafts", () => ({
  clearRentalWizardDraft: vi.fn(),
  loadRentalWizardDraftAxisId: () => "PROPLANE-AAAA0001",
  saveRentalWizardDraft: vi.fn(),
  saveRentalWizardDraftAxisId: vi.fn(),
}));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/demo-property-pipeline", () => ({
  isPropertyActiveForLeads: () => true,
  loadPublicExtraListingsFromServer: () => Promise.resolve([]),
  loadPublicPropertyLeadFromServer: () => Promise.resolve(undefined),
  readExtraListingsPublic: () => [],
}));
vi.mock("@/lib/public-sandbox-listings", () => ({
  filterSandboxFromPublicCatalog: (list: unknown[]) => list,
}));
vi.mock("@/lib/public-demo-access", () => ({
  isProductionPublicSite: () => false,
}));
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: () => undefined,
  getRoomChoiceLabel: (value: string) => value,
  parseRoomChoiceValue: (value: string) => ({ listingRoomId: value }),
}));
vi.mock("@/lib/resident-public-nav", () => ({
  residentBrowseFromApplicationHref: () => "/rent/browse",
}));
vi.mock("@/components/portal/pro-applications", () => ({
  applicationPdfHref: () => "/api/manager-applications/test/pdf?disposition=inline",
  ApplicationDocumentPreview: () => (
    <iframe
      title="Application document"
      data-testid="resident-application-pdf"
      src="/api/manager-applications/test/pdf?disposition=inline"
    />
  ),
}));
vi.mock("@/components/portal/resident-application-editor", () => ({ ResidentApplicationEditor: () => null }));
vi.mock("@/components/marketing/rental-application-finish-panel", () => ({ GroupShareCallout: () => null }));
vi.mock("@/components/marketing/rental-application-wizard", () => ({
  RentalApplicationWizard: () => <div data-testid="rental-wizard" />,
}));

import { ResidentApplicationsPanel } from "@/components/portal/resident-applications-panel";

function inProgressRow(id: string, propertyId: string, property: string): DemoApplicantRow {
  return {
    id,
    name: "Jamie Rivera",
    email: "jamie.rivera@example.com",
    property,
    propertyId,
    stage: "In progress",
    bucket: "pending",
    detail: "Started",
    application: { propertyId, email: "jamie.rivera@example.com" },
  } as DemoApplicantRow;
}

afterEach(() => {
  cleanup();
  ROWS = [];
  portalNavigate.mockReset();
  vi.restoreAllMocks();
});

describe("ResidentApplicationsPanel application detail", () => {
  it("renders the embedded wizard for incomplete applications without a Continue button", async () => {
    ROWS = [inProgressRow("PROPLANE-AAAA0001", "mgr-test-magnolia", "Magnolia House")];

    render(<ResidentApplicationsPanel applicationId="PROPLANE-AAAA0001" bucket="pending" />);

    expect(await screen.findByTestId("rental-wizard")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /continue application/i })).toBeNull();
    expect(screen.getByRole("button", { name: /withdraw application/i })).toBeTruthy();
    expect(screen.queryByText(/^Incomplete$/i)).toBeNull();
  });

  it("renders the inline PDF for submitted pending applications", async () => {
    ROWS = [
      {
        ...inProgressRow("PROPLANE-BBBB0002", "mgr-test-spruce", "Spruce Studio"),
        stage: "Submitted",
        application: { propertyId: "mgr-test-spruce", email: "jamie.rivera@example.com", fullLegalName: "Jamie Rivera" },
      } as DemoApplicantRow,
    ];

    render(<ResidentApplicationsPanel applicationId="PROPLANE-BBBB0002" bucket="pending" />);

    const pdf = await screen.findByTestId("resident-application-pdf");
    expect(pdf.getAttribute("src")).toContain("/api/manager-applications/");
    expect(screen.queryByText(/^Incomplete$/i)).toBeNull();
  });

  it("withdraws from the detail page and returns to the applications list", async () => {
    ROWS = [inProgressRow("PROPLANE-AAAA0001", "mgr-test-magnolia", "Magnolia House")];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      }),
    );

    render(<ResidentApplicationsPanel applicationId="PROPLANE-AAAA0001" bucket="pending" />);

    fireEvent.click(screen.getByRole("button", { name: /^withdraw application$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^withdraw application$/i }));

    await vi.waitFor(() => {
      expect(portalNavigate).toHaveBeenCalledWith("/resident/applications/pending");
    });
  });
});
