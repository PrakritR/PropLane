// @vitest-environment jsdom
//
// Regression coverage for the "glitches back to the start of the application"
// bug: `ResidentApplicationsPanel` used to re-derive WHICH row is "the"
// in-progress application on every render from a snapshot of the URL taken at
// load time (`applyTarget`). That snapshot never updates as the resident edits
// the wizard, so the moment they picked a DIFFERENT room than the one the URL
// happened to name, the strict target match broke, `inProgressRow` went from
// "this row" to `undefined`, and the panel concluded there was suddenly no
// in-progress application — mounting a brand-new, second `RentalApplicationWizard`
// (fresh `step` state) alongside the one already embedded in the expanded row.
// This asserts the wizard mounts exactly once and stays mounted across a room
// change on the SAME application.
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

const PROPERTY_ID = "mgr-test-alder";

function application(over: Partial<RentalWizardFormState>): RentalWizardFormState {
  return {
    propertyId: PROPERTY_ID,
    roomChoice1: "",
    fullLegalName: "Jamie Rivera",
    ...over,
  } as RentalWizardFormState;
}

let ROWS: DemoApplicantRow[] = [];
let searchParams = new URLSearchParams({ propertyId: PROPERTY_ID, listingRoomId: "room-1" });
const mocks = vi.hoisted(() => ({ wizardMountCount: 0 }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/applications/pending/PROPLANE-TESTROOM1",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => searchParams,
}));
vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => vi.fn(),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ email: "jamie.rivera@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: () => {} }),
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
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/lib/resident-public-nav", () => ({
  residentBrowseFromApplicationHref: () => "/rent/browse",
}));
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
  parseRoomChoiceValue: (value: string) => ({ listingRoomId: value.split("::")[1] ?? value }),
}));
vi.mock("@/components/portal/pro-applications", () => ({
  applicationPdfHref: () => "/api/manager-applications/test/pdf?disposition=inline",
}));
vi.mock("@/components/portal/resident-application-editor", () => ({
  ResidentApplicationEditor: () => null,
}));
vi.mock("@/components/marketing/rental-application-finish-panel", () => ({
  GroupShareCallout: () => null,
}));
vi.mock("@/components/marketing/rental-application-wizard", () => ({
  RentalApplicationWizard: () => {
    useEffect(() => {
      mocks.wizardMountCount += 1;
    }, []);
    return null;
  },
}));

import { ResidentApplicationsPanel } from "@/components/portal/resident-applications-panel";

afterEach(() => {
  cleanup();
  ROWS = [];
  mocks.wizardMountCount = 0;
  searchParams = new URLSearchParams({ propertyId: PROPERTY_ID, listingRoomId: "room-1" });
});

describe("ResidentApplicationsPanel — room change on an in-progress application", () => {
  it("keeps the SAME wizard mounted (no remount, no duplicate instance) when the resident picks a different room than the URL named", async () => {
    // The URL names room-1 (e.g. from a "Continue application" deep link or a
    // browse flow's default room), but the resident's draft has already moved
    // to room-2 by the time this render happens — exactly the mismatch that
    // used to break the target match.
    ROWS = [
      {
        id: "PROPLANE-TESTROOM1",
        name: "Jamie Rivera",
        email: "jamie.rivera@example.com",
        property: "Alder Row — 3 rooms",
        propertyId: PROPERTY_ID,
        stage: "In progress",
        bucket: "pending",
        detail: "Started",
        application: application({ roomChoice1: `${PROPERTY_ID}::room-1` }),
      },
    ];

    await act(async () => {
      render(<ResidentApplicationsPanel applicationId="PROPLANE-TESTROOM1" bucket="pending" />);
    });

    const baselineMountCount = mocks.wizardMountCount;
    expect(baselineMountCount).toBe(1);

    // The resident changes their room selection inside the wizard. In the real
    // app this happens via the wizard's own `patchForm`, which calls
    // `syncInProgressApplicationRow` → `replaceManagerApplicationRowInCache` +
    // an upsert; here we simulate its net effect directly: the SAME row id now
    // carries a DIFFERENT room, and the storage layer announces the change.
    ROWS = [
      {
        ...ROWS[0],
        application: application({ roomChoice1: `${PROPERTY_ID}::room-2` }),
      },
    ];
    await act(async () => {
      window.dispatchEvent(new Event("manager-applications-changed"));
    });

    // No NEW mounts — the panel kept treating this as the SAME in-progress
    // application instead of losing the target match and mounting fresh,
    // additional (step-1) wizard instances alongside the existing ones.
    expect(mocks.wizardMountCount).toBe(baselineMountCount);
  });
});
