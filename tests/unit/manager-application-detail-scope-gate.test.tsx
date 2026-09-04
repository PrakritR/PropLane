// @vitest-environment jsdom
//
// Regression: the manager Applications DETAIL view must fail CLOSED on an
// unresolved scope, exactly like the list in the same component.
//
// The bug: `detailRow` guarded its visibility check with
// `if (scopeUserId && !applicationVisibleToPortalUser(...)) return null` — so
// when `scopeUserId` was null the check was skipped entirely and the row was
// returned unchecked. `scopeUserId` is null for a real, reachable window of
// every page load (`useManagerUserId` reports `ready: false, userId: null`
// until auth resolves) and whenever `resolveManagerScopeUserId` yields nothing.
// In that window `/portal/applications/pending/<id>` rendered full applicant
// PII — legal name, email, phone, employer, income, screening result — for ANY
// application id present in the local rows cache, including another manager's.
// The list (`scopedRows`) denied the same rows at the same instant.
//
// These tests render the REAL component against the REAL
// `applicationVisibleToPortalUser` and assert on the rendered DOM, not on a
// helper's return value.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";

/** Rows already in the client-side applications cache. */
let ROWS: DemoApplicantRow[] = [];
/** What `useManagerUserId` reports — null/not-ready models the pre-auth window. */
let AUTH: { userId: string | null; ready: boolean } = { userId: "mgr-self", ready: true };
/** What `resolveManagerScopeUserId` yields — null models an unresolvable scope. */
let SCOPE_RESOLVES: boolean = true;

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/applications/pending/AXIS-90210",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: AUTH.userId, email: null, ready: AUTH.ready }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/manager-applications-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-applications-storage")>();
  return {
    ...actual,
    syncManagerApplicationsFromServer: () => Promise.resolve(ROWS),
    readManagerApplicationRows: () => ROWS,
    deleteManagerApplicationFromServer: () => Promise.resolve({ ok: true }),
  };
});
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-property-pipeline")>();
  const listings: MockProperty[] = [];
  return {
    ...actual,
    syncPropertyPipelineFromServer: () => Promise.resolve(undefined),
    hasCachedPropertyPipeline: () => false,
    readExtraListingsForUser: () => listings,
    readAllExtraListings: () => listings,
    readScopedExtraListings: () => listings,
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
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
  DEMO_GUIDED_USER_ID: "demo-everything",
  resolveManagerScopeUserId: (id: string | null) => (SCOPE_RESOLVES ? id : null),
}));

import { ManagerApplications } from "@/components/portal/pro-applications";

const APPLICANT_NAME = "Maya Alvarez";
const APPLICANT_EMAIL = "maya.alvarez@example.com";
const APPLICANT_EMPLOYER = "Cascade Logistics LLC";
const APPLICANT_INCOME = "8450";

/** A row in the local cache carrying real applicant PII. */
const APPLICATION: DemoApplicantRow = {
  id: "AXIS-90210",
  name: APPLICANT_NAME,
  email: APPLICANT_EMAIL,
  property: "The Magnolia · 2B",
  propertyId: "mgr-magnolia-2b-a1b2c3",
  managerUserId: "mgr-self",
  stage: "Submitted",
  bucket: "pending",
  detail: "Submitted Jul 24, 2026",
  application: {
    fullLegalName: APPLICANT_NAME,
    email: APPLICANT_EMAIL,
    phone: "206-555-0147",
    employer: APPLICANT_EMPLOYER,
    monthlyIncome: APPLICANT_INCOME,
  } as DemoApplicantRow["application"],
};

/** The same row attributed to a DIFFERENT manager — never this viewer's to see. */
const OTHER_MANAGERS_APPLICATION: DemoApplicantRow = {
  ...APPLICATION,
  managerUserId: "mgr-other",
  propertyId: "mgr-other-manager-prop",
};

/** Every PII string the detail view would paint if the gate let the row through. */
function expectNoApplicantPii() {
  for (const secret of [APPLICANT_NAME, APPLICANT_EMAIL, APPLICANT_EMPLOYER, APPLICANT_INCOME]) {
    expect(screen.queryByText(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"))).toBeNull();
  }
  // Belt and braces: the raw markup must not carry it either (a value rendered
  // inside an <input value=…> or a title attribute is still an exposure).
  const html = document.body.innerHTML;
  for (const secret of [APPLICANT_EMAIL, APPLICANT_EMPLOYER]) {
    expect(html).not.toContain(secret);
  }
}

beforeEach(() => {
  ROWS = [];
  AUTH = { userId: "mgr-self", ready: true };
  SCOPE_RESOLVES = true;
});
afterEach(cleanup);

describe("manager application detail — unresolved scope denies", () => {
  it("renders no applicant PII while auth is still resolving", async () => {
    // The exact pre-fix window: rows are already cached (a previous sync, or a
    // client-side navigation), but `useManagerUserId` has not reported yet.
    ROWS = [APPLICATION];
    AUTH = { userId: null, ready: false };

    render(<ManagerApplications bucket="pending" applicationId="AXIS-90210" />);
    await waitFor(() => expect(document.body.textContent).toContain("Application"));

    expectNoApplicantPii();
  });

  it("renders no applicant PII when the manager scope never resolves", async () => {
    // `resolveManagerScopeUserId` returning null is the other null path — auth is
    // ready, but there is no usable manager scope.
    ROWS = [APPLICATION];
    AUTH = { userId: "mgr-self", ready: true };
    SCOPE_RESOLVES = false;

    render(<ManagerApplications bucket="pending" applicationId="AXIS-90210" />);
    await waitFor(() => expect(document.body.textContent).toContain("Application"));

    expectNoApplicantPii();
  });

  it("still denies another manager's application once the scope resolves", async () => {
    ROWS = [OTHER_MANAGERS_APPLICATION];

    render(<ManagerApplications bucket="pending" applicationId="AXIS-90210" />);
    await waitFor(() => expect(document.body.textContent).toContain("Application"));

    expectNoApplicantPii();
  });

  it("renders the manager's own application once the scope resolves", async () => {
    // The other half of the contract: failing closed must not fail SHUT. The very
    // same id, viewer, and cache render the detail as soon as the scope is known.
    ROWS = [APPLICATION];

    render(<ManagerApplications bucket="pending" applicationId="AXIS-90210" />);

    await waitFor(() => {
      expect(screen.getAllByText(APPLICANT_NAME).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(APPLICANT_EMAIL).length).toBeGreaterThan(0);
  });

  it("reveals the detail as soon as auth resolves on a re-render (no reload)", async () => {
    // Denying on an unresolved scope is a gate, not a dead end: the memo
    // re-runs when `scopeUserId` arrives and the same mounted view fills in.
    ROWS = [APPLICATION];
    AUTH = { userId: null, ready: false };

    const { rerender } = render(<ManagerApplications bucket="pending" applicationId="AXIS-90210" />);
    await waitFor(() => expect(document.body.textContent).toContain("Application"));
    expectNoApplicantPii();

    AUTH = { userId: "mgr-self", ready: true };
    rerender(<ManagerApplications bucket="pending" applicationId="AXIS-90210" />);

    await waitFor(() => {
      expect(screen.getAllByText(APPLICANT_NAME).length).toBeGreaterThan(0);
    });
  });
});
