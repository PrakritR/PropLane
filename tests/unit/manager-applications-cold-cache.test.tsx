// @vitest-environment jsdom
//
// End-user regression for the reported bug: "a resident submitted an application
// and it never showed up as pending on my manager portal."
//
// This renders the REAL manager Applications tab against the REAL
// `applicationVisibleToPortalUser`, with the property-pipeline cache still
// un-hydrated — the first-paint race that masked the row. The server already
// returned it (scoped by manager_user_id); the client was dropping it.
//
// Set APPLICATIONS_COLD_CACHE_HTML_DIR to dump each rendered surface's HTML so
// it can be screenshotted with the app's real stylesheet.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { AccountLinkInviteDto } from "@/lib/account-links";
import type { MockProperty } from "@/data/types";

const HTML_DIR = process.env.APPLICATIONS_COLD_CACHE_HTML_DIR;
function dumpHtml(name: string, html: string) {
  if (!HTML_DIR) return;
  fs.mkdirSync(HTML_DIR, { recursive: true });
  fs.writeFileSync(path.join(HTML_DIR, `${name}.body.html`), html, "utf8");
}

/** Rows the (already manager-scoped) server GET handed the client. */
let ROWS: DemoApplicantRow[] = [];
/** The client-side property cache — empty until the pipeline sync lands. */
let CACHED_LISTINGS: MockProperty[] = [];
/** Accepted co-manager links, for the linked-property scenario. */
let INVITES: AccountLinkInviteDto[] = [];
/** Which manager is signed in. */
let VIEWER = "mgr-self";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/applications",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: VIEWER, email: "manager@example.com", ready: true }),
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
// The un-hydrated cache: the reads `applicationVisibleToPortalUser` consults all
// come back empty until the test hydrates them.
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
  return { ...actual, readCachedAccountLinkInvites: () => INVITES };
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
  resolveManagerScopeUserId: (id: string | null) => id,
}));

import { ManagerApplications } from "@/components/portal/pro-applications";
import { PROPERTY_PIPELINE_EVENT } from "@/lib/demo-property-pipeline";

const MY_PROPERTY_ID = "mgr-magnolia-2b-a1b2c3";

/** The resident's freshly submitted application, as the server returns it. */
const RESIDENT_APPLICATION: DemoApplicantRow = {
  id: "AXIS-90210",
  name: "Maya Alvarez",
  email: "maya.alvarez@example.com",
  property: "The Magnolia · 2B",
  propertyId: MY_PROPERTY_ID,
  managerUserId: "mgr-self",
  stage: "Submitted",
  bucket: "pending",
  detail: "Submitted Jul 24, 2026",
};

/** A different manager's application, returned by nothing — must never surface. */
const OTHER_MANAGERS_APPLICATION: DemoApplicantRow = {
  id: "AXIS-77777",
  name: "Not Your Applicant",
  email: "someone.else@example.com",
  property: "Someone Else's Building",
  propertyId: "mgr-other-manager-prop",
  managerUserId: "mgr-other",
  stage: "Submitted",
  bucket: "pending",
};

const listing = (id: string, name: string) => ({ id, name }) as unknown as MockProperty;

/**
 * Let the mount effects (applications sync + pipeline sync) flush, then dump the
 * surface. Dumping BEFORE the assertions is deliberate: it means a red run
 * against the pre-fix code still leaves the empty-state screenshot
 * the manager actually reported.
 */
async function settleAndDump(name: string, container: HTMLElement) {
  await screen.findByRole("link", { name: /Pending/i });
  await new Promise((resolve) => setTimeout(resolve, 0));
  dumpHtml(name, container.innerHTML);
}

beforeEach(() => {
  ROWS = [];
  CACHED_LISTINGS = [];
  INVITES = [];
  VIEWER = "mgr-self";
});
afterEach(cleanup);

describe("manager Applications tab — pending application on a cold property cache", () => {
  it("shows the resident's freshly submitted application before the property cache hydrates", async () => {
    ROWS = [RESIDENT_APPLICATION, OTHER_MANAGERS_APPLICATION];

    const { container } = render(<ManagerApplications />);
    await settleAndDump("pending-visible-cold-cache", container);

    // The manager's own row is on the Pending tab even though the property
    // pipeline has not hydrated (CACHED_LISTINGS is still empty).
    expect(screen.getAllByText("Maya Alvarez").length).toBeGreaterThan(0);
    expect(screen.getAllByText("The Magnolia · 2B").length).toBeGreaterThan(0);
    // Two assertions that used to live here are gone, because neither can be
    // read off this surface any more:
    //   - "No applications yet" — an empty bucket now renders an inline
    //     `PortalListAddRow`, and that row ALSO renders under a populated list,
    //     so it is a render-settled signal, never an emptiness signal.
    //   - the Pending pill's count — routed `DestinationNav` items render the
    //     label only. The item type still accepts `count` and this panel still
    //     passes one, but nothing renders it, so the read only ever saw
    //     "Pending". That dead prop is tracked separately.
    // The rows above and the exclusion below are what this regression is about.
    // Another manager's row is still filtered out on the same cold cache.
    expect(screen.queryByText("Not Your Applicant")).toBeNull();
  });

  it("keeps the Pending tab empty when the only rows belong to another manager", async () => {
    ROWS = [OTHER_MANAGERS_APPLICATION];

    const { container } = render(<ManagerApplications />);

    // Wait for the list to actually render (the ADD row is its last child)
    // before asserting an absence — otherwise "not present yet" passes as
    // "correctly filtered out".
    await waitFor(() =>
      expect(document.querySelector('[data-attr="applications-list-add"]')).not.toBeNull(),
    );
    expect(screen.queryByText("Not Your Applicant")).toBeNull();

    dumpHtml("other-manager-hidden", container.innerHTML);
  });

  it("reveals a co-manager's owner-attributed row once the pipeline event lands", async () => {
    // The co-manager viewer: the row is attributed to the OWNER, so it still has
    // to clear the linked-property check — nothing about the fix short-circuits it.
    VIEWER = "co-user";
    ROWS = [{ ...RESIDENT_APPLICATION, managerUserId: "owner-user" }];

    const { container } = render(<ManagerApplications />);
    await waitFor(() =>
      expect(document.querySelector('[data-attr="applications-list-add"]')).not.toBeNull(),
    );
    expect(screen.queryByText("Not Your Applicant")).toBeNull();
    dumpHtml("co-manager-before-hydrate", container.innerHTML);

    // Cache hydrates: the accepted link now grants applications on that property.
    INVITES = [
      {
        id: "invite-1",
        tabKind: "manager",
        status: "accepted",
        direction: "incoming",
        inviterAxisId: "axis-owner",
        inviteeAxisId: "axis-co",
        inviterDisplayName: "Owner",
        inviteeDisplayName: "Co",
        linkedAxisId: "axis-owner",
        linkedDisplayName: "Owner",
        linkedUserId: "owner-user",
        assignedPropertyIds: [MY_PROPERTY_ID],
        payoutPercentForManager: 15,
        coManagerPermissions: { applications: true },
        propertyCoManagerPermissions: { [MY_PROPERTY_ID]: { applications: true } },
        createdAt: "2026-01-01T00:00:00.000Z",
        respondedAt: "2026-01-02T00:00:00.000Z",
      } satisfies AccountLinkInviteDto,
    ];
    CACHED_LISTINGS = [listing("mgr-co-owned", "Co-managed portfolio")];
    window.dispatchEvent(new Event(PROPERTY_PIPELINE_EVENT));
    await settleAndDump("co-manager-after-hydrate", container);

    // Without the `portfolioTick` memo dependency the list would never recompute.
    expect(screen.getAllByText("Maya Alvarez").length).toBeGreaterThan(0);
  });
});
