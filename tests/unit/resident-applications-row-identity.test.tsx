// @vitest-environment jsdom
//
// Regression coverage for the "clicking row 2 or 3 opens row 1" bug.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";

let ROWS: DemoApplicantRow[] = [];
let searchParams = new URLSearchParams();
const portalNavigate = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/applications/apply",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => searchParams,
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ email: "jamie.rivera@example.com", userId: "resident-test", ready: true }),
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
vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => portalNavigate,
}));
vi.mock("@/hooks/use-prospect-contact-autofill", () => ({
  useProspectContactAutofill: () => ({ ready: true, userId: "resident-test", hasResidentRole: false, name: "Jamie", email: "jamie.rivera@example.com", phone: "" }),
}));
vi.mock("@/hooks/use-quick-apply-eligibility", () => ({ useQuickApplyProfile: () => null }));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  syncManagerApplicationsFromServer: () => Promise.resolve(),
  readManagerApplicationRows: () => ROWS,
  replaceManagerApplicationRowInCache: () => {},
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
vi.mock("@/components/portal/pro-applications", () => ({
  applicationPdfHref: () => "/api/manager-applications/test/pdf?disposition=inline",
}));
vi.mock("@/components/portal/resident-application-editor", () => ({ ResidentApplicationEditor: () => null }));
vi.mock("@/components/marketing/rental-application-wizard", () => ({
  RentalApplicationWizard: () => <div data-testid="rental-wizard" />,
}));

import { ResidentApplicationsPanel } from "@/components/portal/resident-applications-panel";

function inProgressRow(id: string, propertyId: string, property: string): DemoApplicantRow {
  return {
    id,
    name: "Jamie Rivera",
    email: "jamie.rivera@example.com",
    residentUserId: "resident-test",
    property,
    propertyId,
    stage: "In progress",
    bucket: "pending",
    detail: "Started",
    application: { propertyId, email: "jamie.rivera@example.com" },
  } as DemoApplicantRow;
}

function submittedRow(id: string, propertyId: string, property: string): DemoApplicantRow {
  return {
    id,
    name: "Jamie Rivera",
    email: "jamie.rivera@example.com",
    residentUserId: "resident-test",
    property,
    propertyId,
    stage: "Submitted",
    bucket: "pending",
    detail: "",
    application: { propertyId, email: "jamie.rivera@example.com" },
  } as DemoApplicantRow;
}

/**
 * The row for one application, found the way a resident finds it: by the
 * property named on the row (the application's own id is never printed on a
 * row, so the id maps to its property here). Deliberately NOT a DOM-id selector —
 * these lists render through `DataList`, which emits no per-row `id`, and it
 * should not: the responsive shell renders mobile and desktop trees together,
 * so a shared id would be a duplicate. Selecting on visible text is also the
 * stronger assertion for audit F7.
 */
function applicationRow(id: string): HTMLElement {
  const rows = [...document.querySelectorAll<HTMLElement>('.portal-property-row')];
  const property = ROWS.find((row) => row.id === id)?.property ?? id;
  const matches = rows.filter((el) => (el.textContent ?? "").includes(property));
  if (matches.length === 0) throw new Error(`row ${id} not rendered`);
  if (matches.length > 1) throw new Error(`row ${id} matched ${matches.length} rows — property names must be unique`);
  expect(matches[0].textContent ?? "").not.toContain(id);
  return matches[0];
}

function clickApplicationRow(id: string) {
  const row = applicationRow(id);
  // The action trigger is visually trailing but precedes the primary button
  // in the responsive row DOM. Activate the resident's record control.
  const openButton = row.querySelector('button:not([data-attr="record-actions-trigger"])');
  if (!openButton) throw new Error(`record activation missing for ${id}`);
  fireEvent.click(openButton);
}

afterEach(() => {
  cleanup();
  ROWS = [];
  searchParams = new URLSearchParams();
  portalNavigate.mockReset();
});

describe("ResidentApplicationsPanel — each row opens its OWN application", () => {
  it("with several in-progress drafts and no URL target, auto-navigates to NONE (not the first)", async () => {
    ROWS = [
      inProgressRow("PROPLANE-AAAA0001", "mgr-test-magnolia", "Magnolia House"),
      inProgressRow("PROPLANE-BBBB0002", "mgr-test-alder", "Alder Row"),
      submittedRow("PROPLANE-CCCC0003", "mgr-test-cedar", "Cedar Flat"),
    ];
    await act(async () => {
      render(<ResidentApplicationsPanel applyMode />);
    });
    expect(portalNavigate).not.toHaveBeenCalled();
  });

  it("resumes the sole in-progress draft on bare /apply", async () => {
    ROWS = [
      submittedRow("PROPLANE-CCCC0003", "mgr-test-cedar", "Cedar Flat"),
      inProgressRow("PROPLANE-AAAA0001", "mgr-test-magnolia", "Magnolia House"),
    ];
    await act(async () => {
      render(<ResidentApplicationsPanel applyMode />);
    });
    // REPLACE, not push. The resident opened an apply link, not this row —
    // resolving it into the draft they already started is the panel's own doing,
    // so it must not leave a history entry they never chose. Pushing it meant
    // Back landed on /apply, which resolved the same row and sent them straight
    // forward again.
    expect(portalNavigate).toHaveBeenCalledWith("/resident/applications/pending/PROPLANE-AAAA0001", {
      replace: true,
    });
  });

  it("clicking a row navigates to that row's detail page", async () => {
    ROWS = [
      submittedRow("PROPLANE-CCCC0003", "mgr-test-cedar", "Cedar Flat"),
      inProgressRow("PROPLANE-AAAA0001", "mgr-test-magnolia", "Magnolia House"),
    ];
    await act(async () => {
      render(<ResidentApplicationsPanel applyMode />);
    });
    portalNavigate.mockClear();
    await act(async () => {
      clickApplicationRow("PROPLANE-CCCC0003");
    });
    expect(portalNavigate).toHaveBeenCalledWith("/resident/applications/pending/PROPLANE-CCCC0003");
  });

  it("keeps a targeted apply link on one wizard when existing drafts sync", async () => {
    searchParams = new URLSearchParams({ propertyId: "mgr-test-magnolia" });
    await act(async () => { render(<ResidentApplicationsPanel applyMode />); });
    const wizard = screen.getByTestId("rental-wizard");
    ROWS = [
      inProgressRow("PROPLANE-AAAA0001", "mgr-test-magnolia", "Magnolia House"),
      inProgressRow("PROPLANE-BBBB0002", "mgr-test-alder", "Alder Row"),
    ];
    await act(async () => { window.dispatchEvent(new Event("manager-applications-changed")); });
    expect(portalNavigate).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("rental-wizard")).toHaveLength(1);
    expect(screen.getByTestId("rental-wizard")).toBe(wizard);
  });
});

/**
 * Resident audit F7 also covers the EMBEDDED (apply-mode) table. The routed
 * list gained status + date, but the embedded variant still showed only
 * name, property and room, so two applications for the same room read the same.
 */
describe("ResidentApplicationsPanel — the embedded table distinguishes its rows too", () => {
  it("shows each row's status and when it was started", async () => {
    ROWS = [
      {
        ...inProgressRow("PROPLANE-AAAA0001", "mgr-test-magnolia", "Magnolia House"),
        detail: "Started 8/1/2026, 7:48:40 PM",
      },
      {
        ...submittedRow("PROPLANE-BBBB0002", "mgr-test-magnolia", "Magnolia House"),
        detail: "Submitted 8/3/2026, 5:24:39 PM",
      },
    ];
    await act(async () => {
      render(<ResidentApplicationsPanel applyMode />);
    });

    // Same property on both rows, so each is found by what makes it different: its status and date.
    const rowTexts = [...document.querySelectorAll<HTMLElement>(".portal-property-row")].map((el) => el.textContent ?? "");
    const first = rowTexts.find((text) => text.includes("Started Aug 1")) ?? "";
    const second = rowTexts.find((text) => text.includes("Submitted Aug 3")) ?? "";
    expect(first).not.toContain("PROPLANE-AAAA0001");
    expect(second).not.toContain("PROPLANE-BBBB0002");
    expect(first).toContain("Started Aug 1");
    expect(second).toContain("Submitted Aug 3");
    // Same property and room — the rows still have to read differently.
    expect(first).not.toBe(second);
  });
});


it("opens the exact application from View without navigating on menu open", async () => {
  ROWS = [
    submittedRow("PROPLANE-CCCC0003", "mgr-test-cedar", "Cedar Flat"),
    submittedRow("PROPLANE-DDDD0004", "mgr-test-dahlia", "Dahlia Court"),
  ];
  await act(async () => { render(<ResidentApplicationsPanel applyMode />); });
  portalNavigate.mockClear();
  const row = applicationRow("PROPLANE-DDDD0004");
  const trigger = row.querySelector<HTMLButtonElement>('[data-attr="record-actions-trigger"]');
  expect(trigger).toBeTruthy();
  fireEvent.keyDown(trigger!, { key: "ArrowDown" });
  const details = await screen.findByRole("menuitem", { name: "View" });
  expect(portalNavigate).not.toHaveBeenCalled();
  fireEvent.click(details);
  expect(portalNavigate).toHaveBeenCalledExactlyOnceWith("/resident/applications/pending/PROPLANE-DDDD0004");
});


it("requires a resident account for a direct group-only portal invitation", async () => {
  searchParams = new URLSearchParams({ groupLeaderAppId: "PROPLANE-ABCD1234" });
  await act(async () => { render(<ResidentApplicationsPanel applyMode hasResidentRole={false} signedInNonResident />); });
  expect(screen.queryByTestId("rental-wizard")).toBeNull();
  expect(screen.getByRole("heading", { name: "Create your resident account to apply" })).toBeTruthy();
});
