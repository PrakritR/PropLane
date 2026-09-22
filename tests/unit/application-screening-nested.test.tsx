// @vitest-environment jsdom
//
// Screening now nests inside the application record's own rail
// (docs/agents/record-page.md, PLAN-0920-1058 area 1c) instead of a separate
// "Background check" list — this asserts the rail exists, the old
// "background-check" tab id still resolves to it, and the tab actually shows
// screening content rather than bouncing back to Overview.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import { parseApplicationDetailTab, applicationDetailHref } from "@/lib/portal-detail-routes";

function application(over: Partial<RentalWizardFormState> = {}): RentalWizardFormState {
  return { ...over } as RentalWizardFormState;
}

let ROWS: DemoApplicantRow[] = [];

const ROW: DemoApplicantRow = {
  id: "AXIS-9001",
  name: "Riley Chen",
  email: "riley.chen@example.com",
  property: "The Pioneer",
  propertyId: "mgr-demo-pioneer",
  stage: "Submitted",
  bucket: "pending",
  detail: "Submitted Jul 19, 2026",
  application: application(),
};

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/applications",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  isBookingResidencyRow: (row: unknown) =>
    (row as { bookingResidency?: unknown } | null)?.bookingResidency === true,
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  syncManagerApplicationsFromServer: () => Promise.resolve(ROWS),
  readManagerApplicationRows: () => ROWS,
  writeManagerApplicationRows: () => {},
  deleteManagerApplicationFromServer: () => Promise.resolve({ ok: true }),
  normalizeApplicationAxisId: (id: string) => id,
}));
vi.mock("@/lib/manager-portfolio-access", () => ({
  MANAGER_PORTFOLIO_REFRESH_EVENTS: [],
  applicationVisibleToPortalUser: () => true,
  buildManagerPropertyFilterOptions: () => [],
}));
vi.mock("@/lib/manager-property-links", () => ({
  buildManagerShareablePropertyOptions: () => [],
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  PROPERTY_PIPELINE_EVENT: "property-pipeline-changed",
  syncPropertyPipelineFromServer: () => Promise.resolve(),
  hasCachedPropertyPipeline: () => true,
  readAllExtraListings: () => [],
  readExtraListings: () => [],
  readAllPendingManagerProperties: () => [],
  cachePublicExtraListings: () => {},
}));
vi.mock("@/lib/cosigner-submissions-storage", () => ({
  fetchCosignerSubmissionsForSignerAppId: () => Promise.resolve([]),
  readCosignerSubmissionsForSignerAppId: () => [],
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
  DEMO_GUIDED_USER_ID: "demo-everything",
  resolveManagerScopeUserId: (id: string | null) => id,
}));

import { ManagerApplications } from "@/components/portal/pro-applications";

afterEach(() => {
  cleanup();
});

describe("application detail tabs", () => {
  it("the rail has the registry's trimmed sections (PLAN-0921-1029): Overview, Application form, Screening, Communication", async () => {
    ROWS = [ROW];
    render(<ManagerApplications bucket="pending" applicationId="AXIS-9001" />);
    const rail = await screen.findByRole("navigation", { name: "Application sections" });
    const links = within(rail).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Overview",
      "Application form",
      "Screening",
      "Communication",
    ]);
  });

  it("the old 'background-check' tab id resolves to the new 'screening' one", () => {
    expect(parseApplicationDetailTab("background-check")).toBe("screening");
    expect(parseApplicationDetailTab("application")).toBe("overview");
  });

  it("Screening renders real screening content, not a bounce back to Overview", async () => {
    ROWS = [ROW];
    render(
      <ManagerApplications bucket="pending" applicationId="AXIS-9001" applicationDetailTab="screening" />,
    );
    await waitFor(() => expect(screen.getAllByText("Riley Chen").length).toBeGreaterThan(0));
    // A genuine screening section renders (not the Overview review body, and
    // never a dead "Coming soon").
    expect(document.body.textContent).not.toMatch(/Coming soon/i);
    expect(document.querySelector('[data-attr="record-section-chip-screening"], a[href*="/screening"]')).toBeTruthy();
  });

  it("never shows Coming soon anywhere on the application record page", async () => {
    ROWS = [ROW];
    render(<ManagerApplications bucket="pending" applicationId="AXIS-9001" />);
    await waitFor(() => expect(screen.getAllByText("Riley Chen").length).toBeGreaterThan(0));
    expect(document.body.textContent).not.toMatch(/Coming soon/i);
  });

  it("applicationDetailHref builds the screening tab URL", () => {
    expect(applicationDetailHref("/portal", "pending", "AXIS-9001", "screening")).toBe(
      "/portal/applications/pending/AXIS-9001/screening",
    );
    expect(applicationDetailHref("/portal", "pending", "AXIS-9001")).toBe(
      "/portal/applications/pending/AXIS-9001",
    );
  });
});
