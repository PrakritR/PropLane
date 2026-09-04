// @vitest-environment jsdom
//
// Captain path regression: manager Applications → Incomplete tab → expand row →
// Delete must remove the draft and keep it gone after the next background sync.
// The bug was `deleteApplication` optimistically filtering React state only;
// `syncManagerApplicationsFromServer` union-merges against `memoryRows`, so the
// row was resurrected on the 20s poll / focus sync ("application glitches").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";

const INCOMPLETE_ROW: DemoApplicantRow = {
  id: "PROPLANE-INCOMPLETE1",
  name: "ambika Mago",
  email: "ambika@example.com",
  property: "5257 Brooklyn",
  propertyId: "mgr-brooklyn-room1",
  managerUserId: "mgr-self",
  // Delete is a STATUS-SPECIFIC action after 3c23cfc2 ("status-specific
  // actions"): the detail footer offers it on a rejected application only, not
  // on an in-progress draft. The behaviour under test is the cache write — that
  // deleting drops the row so a later sync cannot resurrect it — so the row is
  // staged in the status where the control actually exists.
  stage: "Rejected",
  bucket: "rejected",
  detail: "Started",
};

let ROWS: DemoApplicantRow[] = [];
let CACHED_LISTINGS: MockProperty[] = [];
let writtenRows: DemoApplicantRow[] | null = null;
const fetchMock = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/applications",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-self", email: "manager@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/lib/manager-applications-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-applications-storage")>();
  return {
    ...actual,
    syncManagerApplicationsFromServer: () => Promise.resolve(ROWS),
    readManagerApplicationRows: () => ROWS,
    writeManagerApplicationRows: (rows: DemoApplicantRow[]) => {
      writtenRows = rows;
      ROWS = rows;
    },
    deleteManagerApplicationFromServer: vi.fn(async () => ({ ok: true })),
  };
});
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-property-pipeline")>();
  return {
    ...actual,
    syncPropertyPipelineFromServer: () => Promise.resolve(undefined),
    hasCachedPropertyPipeline: () => CACHED_LISTINGS.length > 0,
    readExtraListingsForUser: () => CACHED_LISTINGS,
    readAllExtraListings: () => CACHED_LISTINGS,
    readScopedExtraListings: () => CACHED_LISTINGS,
    readPendingManagerPropertiesForUser: () => [],
    readAllPendingManagerProperties: () => [],
  };
});
vi.mock("@/lib/portal-data-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal-data-store")>();
  return { ...actual, readCachedAccountLinkInvites: () => [] };
});
vi.mock("@/lib/pro-relationships", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pro-relationships")>();
  return {
    ...actual,
    readProRelationships: () => [],
    syncProRelationshipsFromServer: () => Promise.resolve([]),
  };
});
vi.mock("@/lib/manager-property-links", () => ({
  buildManagerShareablePropertyOptions: () => [],
}));
vi.mock("@/lib/cosigner-submissions-storage", () => ({
  fetchCosignerSubmissionsForSignerAppId: () => Promise.resolve([]),
  readCosignerSubmissionsForSignerAppId: () => [],
}));
vi.mock("@/lib/household-charges", () => ({
  findHoldingDepositCharge: () => undefined,
  removeAllApplicationCharges: () => undefined,
  removeResidentHouseholdPaymentData: () => undefined,
  syncHouseholdChargesFromServer: () => Promise.resolve(),
}));
vi.mock("@/lib/lease-pipeline-storage", () => ({
  deleteLeasePipelineRowsForResident: () => undefined,
}));
vi.mock("@/lib/manager-work-orders-storage", () => ({
  deleteManagerWorkOrdersForResident: () => undefined,
}));
vi.mock("@/lib/service-requests-storage", () => ({
  deleteServiceRequestsForResident: () => undefined,
}));
vi.mock("@/lib/resident-lease-upload", () => ({
  clearUploadedOwnLease: () => undefined,
}));
vi.mock("@/lib/portal-inbox-storage", () => ({
  loadPersistedInbox: () => [],
  persistInbox: () => undefined,
  MANAGER_INBOX_STORAGE_KEY: "mgr-inbox",
}));
vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: () => false,
  DEMO_GUIDED_USER_ID: "demo-everything",
  resolveManagerScopeUserId: (id: string | null) => id,
}));

import { ManagerApplications } from "@/components/portal/pro-applications";
import { deleteManagerApplicationFromServer } from "@/lib/manager-applications-storage";

beforeEach(() => {
  ROWS = [INCOMPLETE_ROW];
  CACHED_LISTINGS = [{ id: "mgr-brooklyn-room1", name: "5257 Brooklyn" } as MockProperty];
  writtenRows = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/portal/delete-resident-access")) {
      return { ok: true, json: async () => ({ ok: true, mode: "purged" }) };
    }
    return { ok: true, json: async () => ({ rows: [] }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("manager Applications — delete incomplete draft", () => {
  it("drops the row from the session cache when Delete is pressed so sync cannot resurrect it", async () => {
    // Applications are a list → detail route now; actions (including Delete) live on the detail page.
    render(<ManagerApplications bucket="rejected" applicationId={INCOMPLETE_ROW.id} />);

    const deleteBtn = document.querySelector('[data-attr="application-delete"]');
    expect(deleteBtn).not.toBeNull();
    fireEvent.click(deleteBtn!);

    await waitFor(() => {
      expect(writtenRows).not.toBeNull();
      expect(writtenRows?.some((row) => row.id === INCOMPLETE_ROW.id)).toBe(false);
    });
    await waitFor(() => expect(screen.queryByText("ambika Mago")).toBeNull());
    expect(deleteManagerApplicationFromServer).toHaveBeenCalledWith(INCOMPLETE_ROW.id);
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/portal/delete-resident-access",
      expect.anything(),
    );
  });
});
