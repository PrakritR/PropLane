// @vitest-environment jsdom
//
// Regression coverage for the "clicking row 2 or 3 opens row 1" bug.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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
 * application id printed on the row. Deliberately NOT a DOM-id selector —
 * these lists render through `DataList`, which emits no per-row `id`, and it
 * should not: the responsive shell renders mobile and desktop trees together,
 * so a shared id would be a duplicate. Selecting on visible text is also the
 * stronger assertion for audit F7.
 */
function applicationRow(id: string): HTMLElement {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="data-list-mobile-row"]')];
  const matches = rows.filter((el) => (el.textContent ?? "").includes(id));
  if (matches.length === 0) throw new Error(`row ${id} not rendered`);
  if (matches.length > 1) throw new Error(`row ${id} matched ${matches.length} rows — ids must be unique`);
  return matches[0];
}

function clickDesktopRow(id: string) {
  const row = applicationRow(id);
  const openButton = row.querySelector("button");
  fireEvent.click(openButton ?? row);
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
    expect(portalNavigate).toHaveBeenCalledWith("/resident/applications/pending/PROPLANE-AAAA0001");
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
      clickDesktopRow("PROPLANE-CCCC0003");
    });
    expect(portalNavigate).toHaveBeenCalledWith("/resident/applications/pending/PROPLANE-CCCC0003");
  });

  it("auto-opens the URL-targeted in-progress application on apply", async () => {
    ROWS = [
      inProgressRow("PROPLANE-AAAA0001", "mgr-test-magnolia", "Magnolia House"),
      inProgressRow("PROPLANE-BBBB0002", "mgr-test-alder", "Alder Row"),
    ];
    searchParams = new URLSearchParams({ propertyId: "mgr-test-magnolia" });
    await act(async () => {
      render(<ResidentApplicationsPanel applyMode />);
    });

    expect(portalNavigate).toHaveBeenCalledWith("/resident/applications/pending/PROPLANE-AAAA0001");

    portalNavigate.mockClear();
    await act(async () => {
      clickDesktopRow("PROPLANE-BBBB0002");
    });
    expect(portalNavigate).toHaveBeenCalledWith("/resident/applications/pending/PROPLANE-BBBB0002");
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

    const first = applicationRow("PROPLANE-AAAA0001").textContent ?? "";
    const second = applicationRow("PROPLANE-BBBB0002").textContent ?? "";
    expect(first).toContain("Started 8/1/2026, 7:48:40 PM");
    expect(second).toContain("Submitted 8/3/2026, 5:24:39 PM");
    // Same property and room — the rows still have to read differently.
    expect(first).not.toBe(second);
  });
});
