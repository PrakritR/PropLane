// @vitest-environment jsdom
//
// A nameless in-progress application is STORED with `name: ""` (F-FIN-2 — the
// literal "Applicant" placeholder used to leak into finance rows). Every
// surface that prints an applicant therefore has to fall back to the email,
// which does identify the person. The manager Applications tab did not, so a
// draft rendered as a blank row and a blank detail header.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";

let ROWS: DemoApplicantRow[] = [];

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/applications",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-self", email: "manager@example.com", ready: true }),
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
vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: () => false,
  DEMO_GUIDED_USER_ID: "demo-everything",
  resolveManagerScopeUserId: (id: string | null) => id,
}));

import { ManagerApplications } from "@/components/portal/pro-applications";

const NAMELESS_DRAFT: DemoApplicantRow = {
  id: "AXIS-40404",
  name: "",
  email: "nameless.draft@example.com",
  property: "The Magnolia · 2B",
  propertyId: "mgr-magnolia-2b-a1b2c3",
  managerUserId: "mgr-self",
  stage: "In progress",
  bucket: "pending",
  detail: "Started Aug 1, 2026",
};

/** A row still carrying the old STORED placeholder, from before F-FIN-2. */
const LEGACY_PLACEHOLDER_DRAFT: DemoApplicantRow = {
  ...NAMELESS_DRAFT,
  id: "AXIS-50505",
  name: "Applicant",
  email: "legacy.placeholder@example.com",
};

beforeEach(() => {
  ROWS = [];
});
afterEach(cleanup);

describe("manager Applications — an applicant with no stored name", () => {
  it("identifies the list row by email instead of rendering a blank name", async () => {
    ROWS = [NAMELESS_DRAFT];

    render(<ManagerApplications bucket="incomplete" />);
    await screen.findByRole("link", { name: /Incomplete/i });

    // Exactly once: the name line resolves to the email, so echoing it as the
    // row's preview would print the same identity twice.
    expect(screen.getAllByText("nameless.draft@example.com")).toHaveLength(1);
    expect(screen.queryByText("Applicant")).toBeNull();
  });

  it("still shows the email beside a real name", async () => {
    ROWS = [{ ...NAMELESS_DRAFT, name: "Maya Chen" }];

    render(<ManagerApplications bucket="incomplete" />);
    await screen.findByRole("link", { name: /Incomplete/i });

    expect(screen.getAllByText("Maya Chen").length).toBeGreaterThan(0);
    expect(screen.getAllByText("nameless.draft@example.com").length).toBeGreaterThan(0);
  });

  it("prefers the email over a legacy stored 'Applicant' placeholder", async () => {
    ROWS = [LEGACY_PLACEHOLDER_DRAFT];

    render(<ManagerApplications bucket="incomplete" />);
    await screen.findByRole("link", { name: /Incomplete/i });

    expect(screen.getAllByText("legacy.placeholder@example.com").length).toBeGreaterThan(0);
    expect(screen.queryByText("Applicant")).toBeNull();
  });

  it("titles the detail page with the email rather than an empty header", async () => {
    ROWS = [NAMELESS_DRAFT];

    render(<ManagerApplications bucket="incomplete" applicationId={NAMELESS_DRAFT.id} />);
    const titled = await screen.findAllByText("nameless.draft@example.com");

    // The header's title line — a blank title is what this covers — and not
    // repeated underneath it as the subtitle.
    expect(titled[0]!.className).toContain("font-semibold");
    expect(titled).toHaveLength(1);
    expect(screen.queryByText("Applicant")).toBeNull();
  });
});
