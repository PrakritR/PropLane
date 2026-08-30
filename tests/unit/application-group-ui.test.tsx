// @vitest-environment jsdom
//
// Renders the two user-facing surfaces the group-application change adds:
//
//   1. `GroupShareCallout` — the applicant's Group ID hand-off (organizer,
//      joining member, and the post-rejection reference-only variant).
//   2. `ManagerApplications` — resident-clustered list (Tours-style) plus the
//      group context inside an expanded application detail.
//
// Set GROUP_UI_HTML_DIR to also dump each rendered surface's HTML to that
// directory so it can be screenshotted with the app's real stylesheet.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

const HTML_DIR = process.env.GROUP_UI_HTML_DIR;
function dumpHtml(name: string, html: string) {
  if (!HTML_DIR) return;
  fs.mkdirSync(HTML_DIR, { recursive: true });
  fs.writeFileSync(path.join(HTML_DIR, `${name}.body.html`), html, "utf8");
}

const GROUP_ID = "PROPLANE-7KQ2MW9D";

const ORGANIZER_ID = "PROPLANE-7KQ2MW9D";

function application(over: Partial<RentalWizardFormState>): RentalWizardFormState {
  return {
    applyingAsGroup: "yes",
    groupRole: "first",
    groupSize: "3",
    groupId: GROUP_ID,
    groupLeaderAppId: "",
    ...over,
  } as RentalWizardFormState;
}

/** Rows the mocked storage layer hands the manager panel; swapped per scenario. */
let ROWS: DemoApplicantRow[] = [];

/** Organizer (approved), one joining member in screening, one still filling the wizard. */
const HOUSEHOLD_ROWS: DemoApplicantRow[] = [
  {
    id: "AXIS-1001",
    name: "Jordan Reyes",
    email: "jordan.reyes@example.com",
    property: "The Pioneer",
    propertyId: "mgr-demo-pioneer",
    stage: "Approved",
    bucket: "approved",
    detail: "Submitted Jul 18, 2026",
    application: application({ groupRole: "first", groupSize: "3" }),
  },
  {
    id: "AXIS-1002",
    name: "Priya Nair",
    email: "priya.nair@example.com",
    property: "The Pioneer",
    propertyId: "mgr-demo-pioneer",
    stage: "Submitted",
    bucket: "pending",
    detail: "Submitted Jul 19, 2026",
    backgroundCheckStatus: "pending_review",
    application: application({ groupRole: "joining", groupSize: "" }),
  },
  {
    id: "AXIS-1003",
    name: "Sam Okafor",
    email: "sam.okafor@example.com",
    property: "The Pioneer",
    propertyId: "mgr-demo-pioneer",
    stage: "In progress",
    bucket: "pending",
    detail: "Started Jul 20, 2026",
    application: application({ groupRole: "joining", groupSize: "" }),
  },
];

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/applications",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  // The real sync RESOLVES TO THE ROWS and the panel pipes it straight into
  // `setRows`. Resolving to undefined here wiped the list the panel had just
  // read synchronously, so every row assertion saw an empty table.
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
  // The merged-in ApplicationGroupSection resolves its listing via getPropertyById,
  // which reads these; the roster/badges under test don't depend on the listing, so
  // empty lookups are fine — they just must exist on the mock.
  readAllExtraListings: () => [],
  readExtraListings: () => [],
  readAllPendingManagerProperties: () => [],
  cachePublicExtraListings: () => {},
}));
vi.mock("@/lib/cosigner-submissions-storage", () => ({
  fetchCosignerSubmissionsForSignerAppId: () => Promise.resolve([]),
  readCosignerSubmissionsForSignerAppId: () => [],
}));
vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: () => false,
  DEMO_GUIDED_USER_ID: "demo-everything",
  resolveManagerScopeUserId: (id: string | null) => id,
}));

import { GroupShareCallout } from "@/components/marketing/rental-application-finish-panel";
import { ManagerApplications } from "@/components/portal/manager-applications";
import { makeApplicationGroupId } from "@/lib/rental-application/application-groups";

afterEach(cleanup);

describe("group application — applicant Group ID hand-off", () => {
  it("shows the organizer a shareable invite link sized to the household", () => {
    const { container } = render(
      <div className="mx-auto max-w-xl p-6">
        <GroupShareCallout leaderAppId={ORGANIZER_ID} groupRole="first" groupSize="3" />
      </div>,
    );
    // Copy matches the compacted `GroupInviteCallout` the organizer now sees:
    // one header line carrying the label, the recipient count and the Group ID.
    expect(screen.getByText("Roommate invite")).toBeTruthy();
    expect(screen.getByText(/send to 2 roommates of 3/)).toBeTruthy();
    expect(screen.getByText(/groupLeaderAppId=PROPLANE-7KQ2MW9D/)).toBeTruthy();
    dumpHtml("callout-organizer", container.innerHTML);
  });

  it("tells a joining member their application is linked", () => {
    const { container } = render(
      <div className="mx-auto max-w-xl p-6">
        <GroupShareCallout groupRole="joining" />
      </div>,
    );
    expect(screen.getByText("You joined a group application")).toBeTruthy();
    expect(screen.getByText(/reviews you together/)).toBeTruthy();
    dumpHtml("callout-joining", container.innerHTML);
  });

  it("keeps the organizer application id readable but drops the share pitch once rejected", () => {
    const { container } = render(
      <div className="mx-auto max-w-xl p-6">
        <GroupShareCallout leaderAppId={ORGANIZER_ID} groupRole="first" groupSize="3" shareable={false} />
      </div>,
    );
    expect(screen.getByText("Group application")).toBeTruthy();
    expect(screen.getByText(/kept here for reference/)).toBeTruthy();
    expect(screen.queryByText(/Invite your roommates/)).toBeNull();
    dumpHtml("callout-rejected", container.innerHTML);
  });

  it("mints ids in the PROPLANE- format the wizard validates", () => {
    const id = makeApplicationGroupId();
    expect(id.startsWith("PROPLANE-")).toBe(true);
    expect(id.length).toBeGreaterThanOrEqual(12);
  });
});

describe("group application — manager reconciliation", () => {
  it("names every applicant on each tab and keeps group context in detail only", async () => {
    ROWS = HOUSEHOLD_ROWS;
    const { container, rerender } = render(<ManagerApplications bucket="pending" />);

    // Pending tab: Priya submitted; Sam is incomplete on another tab; Jordan is approved elsewhere.
    // These three share a Group ID, so they cluster into one HOUSEHOLD card (the
    // later `group household lists` rule) rather than a per-resident card — but
    // each member must still be named on their own row.
    await waitFor(() => expect(screen.getAllByText("Priya Nair").length).toBeGreaterThan(0));
    expect(document.querySelector("[data-attr='applications-resident-groups']")).toBeTruthy();
    expect(screen.getByText(/Group \d+\/\d+/)).toBeTruthy();
    dumpHtml("manager-rows", container.innerHTML);

    rerender(<ManagerApplications bucket="incomplete" />);
    expect(screen.getAllByText("Sam Okafor").length).toBeGreaterThan(0);
    rerender(<ManagerApplications bucket="pending" />);
    await waitFor(() => expect(screen.getAllByText("Priya Nair").length).toBeGreaterThan(0));

    // Expanded application detail no longer renders a separate group roster card —
    // other members appear inside the application PDF instead.
    rerender(<ManagerApplications bucket="pending" applicationId="AXIS-1002" />);
    await waitFor(() => expect(screen.getAllByText("Priya Nair").length).toBeGreaterThan(0));
    expect(screen.queryByText("Group application members")).toBeNull();
    expect(screen.queryByTestId("application-group-members-summary")).toBeNull();
    dumpHtml("manager-expanded", container.innerHTML);
  });

  it("names an approved applicant in their cluster card", async () => {
    ROWS = HOUSEHOLD_ROWS;
    render(<ManagerApplications bucket="approved" />);
    await waitFor(() => expect(screen.getAllByText("Jordan Reyes").length).toBeGreaterThan(0));
    expect(document.querySelector("[data-attr='applications-resident-groups']")).toBeTruthy();
  });

  it("names each applicant separately when a group's members differ", async () => {
    // Two applications share a group id but are different people. The list clusters
    // them by GROUP ID into one household card, so the card header cannot identify
    // anyone — each member has to be named on their own row instead.
    ROWS = [
      {
        id: "AXIS-2001",
        name: "Casey Lin",
        email: "casey.lin@example.com",
        property: "Cascade Lofts",
        stage: "Submitted",
        bucket: "pending",
        detail: "Submitted Jul 19, 2026",
        application: application({ groupRole: "joining", groupSize: "", groupId: "PROPLANE-ORPHAN01" }),
      },
      {
        id: "AXIS-2002",
        name: "Devon Marsh",
        email: "devon.marsh@example.com",
        property: "Cascade Lofts",
        stage: "Submitted",
        bucket: "pending",
        detail: "Submitted Jul 19, 2026",
        application: application({ groupRole: "joining", groupSize: "", groupId: "PROPLANE-ORPHAN01" }),
      },
      ...["Ada Vance", "Bo Whitaker", "Cleo Park"].map((name, i) => ({
        id: `AXIS-30${i}`,
        name,
        email: `${name.toLowerCase().replace(" ", ".")}@example.com`,
        property: "Emerald Court",
        stage: "Submitted",
        bucket: "pending" as const,
        detail: "Submitted Jul 20, 2026",
        application: application({
          groupRole: i === 0 ? ("first" as const) : ("joining" as const),
          groupSize: i === 0 ? "2" : "",
          groupId: "PROPLANE-OVER0001",
        }),
      })),
    ];

    const { container, rerender: rerenderEdge } = render(<ManagerApplications />);
    await waitFor(() => expect(screen.getByText("Casey Lin")).toBeTruthy());
    expect(screen.getByText("Devon Marsh")).toBeTruthy();
    dumpHtml("manager-edge-rows", container.innerHTML);

    rerenderEdge(<ManagerApplications bucket="pending" applicationId="AXIS-300" />);
    await waitFor(() => expect(screen.getAllByText("Ada Vance").length).toBeGreaterThan(0));
    // The expanded detail no longer carries a group roster card — the roster
    // moved into the application PDF, which took the over-subscription warning
    // ("N carry this Group ID, more than the 2 the organizer declared") with it.
    // `ApplicationGroupSection` still computes `isOverSubscribed` but is no
    // longer rendered anywhere, so nothing surfaces that warning today.
    expect(screen.queryByText(/carry this Group ID/)).toBeNull();
    dumpHtml("manager-edge-expanded", container.innerHTML);
  });
});
