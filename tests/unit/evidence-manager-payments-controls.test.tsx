// @vitest-environment jsdom
//
// EVIDENCE HARNESS — the two Payments action rows a manager actually reads.
//
// 1. The Payments SECTION publishes Filter/Sort · Settings · Setup, and no
//    "Check": the receipt scan runs on its own, so the button only ever
//    repeated work the page had already done.
// 2. A resident's Payments TAB publishes the same two words — Settings and
//    Setup — instead of the old "Reminders" / "Payment setup" pair, because
//    that tab is the portfolio list scoped to one person.
//
// Both surfaces are rendered with `renderToStaticMarkup` rather than mounted:
// mounting either panel in jsdom never settles (an environment limit — the
// same is true of the pre-change components, see
// `evidence-group-house-clusters.test.tsx`), while both action rows are built
// in render-time memos, so static markup shows the real controls.
//
// Set EVIDENCE_DIR to dump each rendered surface's HTML so it can be
// screenshotted with the app's real stylesheet.
import { afterAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const captured: { name: string; html: string }[] = [];
function dump(name: string, html: string) {
  captured.push({ name, html });
}
afterAll(() => {
  if (!EVIDENCE_DIR || captured.length === 0) return;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html } of captured) {
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${name}.body.html`), html, "utf8");
  }
});

const MANAGER_ID = "mgr-evidence-1";
const HOUSE = "5259 Brooklyn Ave NE";
const PROP_ID = "mgr-evidence-house";
const RESIDENT_ID = "AXIS-4001";

function houseProperty(): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.rooms = [
    {
      id: "room-a",
      name: "Room A",
      floor: "",
      furnished: "furnished",
      amenities: [],
      photoDataUrls: [],
      videoDataUrl: "",
      monthlyRent: 1100,
      utilitiesEstimate: "120",
      deposit: "500",
      moveInFee: "150",
      available: true,
    } as unknown as ManagerRoomSubmission,
  ];
  return {
    id: PROP_ID,
    title: HOUSE,
    tagline: "",
    address: HOUSE,
    zip: "98105",
    neighborhood: "U District",
    beds: 3,
    baths: 2,
    rentLabel: "$1100/mo",
    available: "Now",
    petFriendly: false,
    buildingId: PROP_ID,
    buildingName: HOUSE,
    unitLabel: "",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  } as MockProperty;
}

const PROPERTIES: MockProperty[] = [houseProperty()];

function residentRow(): DemoApplicantRow {
  return {
    id: RESIDENT_ID,
    name: "Priya Raman",
    email: "priya@example.com",
    property: HOUSE,
    propertyId: PROP_ID,
    stage: "Approved",
    bucket: "approved",
    detail: "Submitted Aug 1, 2026",
    managerUserId: MANAGER_ID,
    manualResidentDetails: { leaseStart: "2026-09-01", leaseTerm: "12 months" },
    application: { propertyId: PROP_ID, fullName: "Priya Raman", email: "priya@example.com" } as unknown as RentalWizardFormState,
  } as unknown as DemoApplicantRow;
}

const ROWS: DemoApplicantRow[] = [residentRow()];

// Every server sync in these panels goes through fetch; jsdom has no origin for
// the relative routes, so answer them all with an empty payload.
vi.stubGlobal(
  "fetch",
  async () =>
    new Response(JSON.stringify({ rows: [], records: [], messages: [], settings: null, ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
);

vi.mock("@/components/portal/payment-schedule-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/portal/payment-schedule-ui")>()),
  useScheduledPaymentMessages: () => ({
    messages: [],
    settings: null,
    reload: () => Promise.resolve(),
    setSettings: () => {},
  }),
}));
vi.mock("@/components/portal/pro-resident-detail-inbox", () => ({ ManagerResidentDetailInbox: () => null }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/payments",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: MANAGER_ID, email: "mgr@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: () => {} }) }));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/portal-base-path-client", () => ({ usePaidPortalBasePath: () => "/portal" }));
vi.mock("@/lib/manager-applications-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
  syncManagerApplicationsFromServer: () => Promise.resolve(),
  readManagerApplicationRows: () => ROWS,
}));
vi.mock("@/lib/manager-portfolio-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-portfolio-access")>()),
  applicationVisibleToPortalUser: () => true,
  buildManagerPropertyFilterOptions: () => [{ id: PROP_ID, label: HOUSE }],
  collectLinkedPropertyIdsForModule: () => new Set<string>(),
  readLinkedListingsForUser: () => [],
  resolvePropertyLabelForId: () => HOUSE,
}));
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-property-pipeline")>()),
  syncPropertyPipelineFromServer: () => Promise.resolve(),
  hasCachedPropertyPipeline: () => true,
  readAllExtraListings: () => PROPERTIES,
  readExtraListings: () => [],
  readExtraListingsForUser: () => PROPERTIES,
  readScopedExtraListings: () => PROPERTIES,
  readAllPendingManagerProperties: () => [],
  readPendingManagerPropertiesForUser: () => [],
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
  resolveManagerScopeUserId: (id: string | null) => id,
}));

import { ManagerPayments } from "@/components/portal/pro-payments";
import { ManagerResidents } from "@/components/portal/pro-residents";

describe("evidence · Payments action rows", () => {
  it("the Payments section publishes Settings and Setup, and no Check", () => {
    const html = renderToStaticMarkup(<ManagerPayments direction="incoming" bucket="pending" />);

    expect(html).toContain('data-attr="payments-settings-open"');
    expect(html).toContain('data-attr="payments-setup"');
    // The Check button is gone from the action row entirely.
    expect(html).not.toContain('data-attr="manager-check-manual-payments"');
    expect(html).not.toMatch(/>Check</);
    dump("payments-section-action-row", html);
  });

  it("a resident's Payments tab publishes the SAME Settings and Setup", () => {
    const html = renderToStaticMarkup(
      <ManagerResidents residentId={RESIDENT_ID} detailTab="payments" />,
    );

    expect(html).toContain('data-attr="resident-payments-settings-open"');
    expect(html).toContain('data-attr="resident-payment-setup-open"');
    // The old pair is gone: neither the attribute nor the words it carried.
    expect(html).not.toContain('data-attr="resident-payments-reminder-settings"');
    expect(html).not.toMatch(/>Reminders</);
    expect(html).not.toMatch(/>Payment setup</);
    dump("resident-payments-tab-action-row", html);
  });
});
