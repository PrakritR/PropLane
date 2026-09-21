// @vitest-environment jsdom
// A resident's maintenance/add-on service row is now a record page
// (PLAN-0920-1058, area 1c): the row navigates to /resident/services/<id>[/<tab>]
// instead of expanding inline.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const navigate = vi.fn();
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => async () => true,
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "res-1", email: "resident@test.proplane.local", ready: true }),
}));
vi.mock("@/hooks/use-portal-row-selection", () => ({
  usePortalRowSelection: () => ({
    selectedIds: new Set(),
    toggleSelected: () => {},
    clearSelection: () => {},
    setSelectedIds: () => {},
  }),
}));

const WORK_ORDER = {
  id: "wo-1",
  title: "Fix leaking sink",
  status: "Open",
  bucket: "open" as const,
  residentName: "Test Resident",
  residentEmail: "resident@test.proplane.local",
  propertyId: "prop-1",
  propertyName: "123 Main St",
  unit: "",
  scheduledAtIso: "",
  scheduled: "",
  description: "The kitchen sink is leaking under the cabinet.",
  priority: "Medium",
  reference: "WO-1001",
  entryPermission: "call_first" as const,
  photoDataUrls: [] as string[],
};

vi.mock("@/lib/manager-work-orders-storage", () => ({
  MANAGER_WORK_ORDERS_EVENT: "manager-work-orders",
  readManagerWorkOrderRows: () => [WORK_ORDER],
  syncManagerWorkOrdersFromServer: async () => [WORK_ORDER],
  updateManagerWorkOrder: () => {},
  deleteManagerWorkOrderRow: () => {},
}));
vi.mock("@/lib/service-requests-storage", () => ({
  SERVICE_REQUESTS_EVENT: "service-requests",
  readServiceRequestsForResident: () => [],
  syncServiceRequestsFromServer: async () => [],
  deleteServiceRequest: () => {},
  updateServiceRequest: () => {},
  hasDeposit: () => false,
  isServiceRequestFeePaid: () => false,
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications",
  readManagerApplicationRows: () => [],
  syncManagerApplicationsFromServer: async () => [],
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  PROPERTY_PIPELINE_EVENT: "property-pipeline",
  loadResidentPropertyFromServer: async () => null,
  syncPropertyPipelineFromServer: async () => {},
  subscribePropertyCatalogScope: () => () => {},
  propertyCatalogScopeKey: () => "test-scope",
}));
vi.mock("@/lib/lease-pipeline-storage", () => ({
  LEASE_PIPELINE_EVENT: "lease-pipeline",
  findLeaseForResidentEmail: () => null,
  hasBothLeaseSignatures: () => false,
  syncLeasePipelineFromServer: async () => [],
}));
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: () => undefined,
}));

import { ResidentServicesPanel } from "@/components/portal/resident-services-panel";

afterEach(() => {
  cleanup();
  navigate.mockClear();
});

describe("resident service row opens the record page", () => {
  it("clicking a maintenance row navigates to /resident/services/<compositeKey>", async () => {
    render(<ResidentServicesPanel basePath="/resident" />);
    const row = await screen.findByText("Fix leaking sink");
    fireEvent.click(row);
    // The composite "kind::id" key is encodeURIComponent'd like any other
    // record id (":" becomes "%3A"), matching every other record href.
    expect(navigate).toHaveBeenCalledWith("/resident/services/maintenance%3A%3Awo-1");
  });
});

describe("resident service record page", () => {
  it("the rail has Overview, Updates, Photos, Communication and the header icons match the registry", async () => {
    render(<ResidentServicesPanel basePath="/resident" serviceId="maintenance::wo-1" />);
    await screen.findAllByText("Fix leaking sink");

    const rail = screen.getByRole("navigation", { name: "Service sections" });
    const links = within(rail).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Overview", "Updates", "Photos", "Communication"]);

    expect(document.querySelector('[data-attr="record-header-action-edit"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="record-header-action-cancel"]')).not.toBeNull();
    // "Message" is also the phone sticky primary's own button (jsdom renders
    // both, unlike a real browser where the desktop icon row is `hidden`
    // below `lg`), so it's queried by data-attr too.
    expect(document.querySelector('[data-attr="record-header-action-message"]')).not.toBeNull();
  });

  it("shows a not-found state for an unknown service id", () => {
    render(<ResidentServicesPanel basePath="/resident" serviceId="maintenance::does-not-exist" />);
    expect(screen.getByText("Service not found.")).toBeTruthy();
  });
});
