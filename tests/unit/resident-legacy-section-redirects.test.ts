import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeResolves } from "../helpers/route-resolves";

/**
 * Ordering regression: the resident STAGE GUARD in render-portal-section.tsx
 * must run AFTER the legacy section redirects, never before.
 *
 * `inbox`, `financials` and `bugs-feedback` are legacy aliases, not resident nav
 * sections, so `isResidentPathAllowedForAccess` answers "not allowed" for every
 * one of them. When the guard ran first it redirected all three to the resident
 * home page, which shipped to production: `/resident/financials/summary`,
 * `/resident/finances`, `/resident/inbox/unopened` (an old push-notification
 * deep link) and `/resident/bugs-feedback` all landed on the dashboard.
 *
 * These tests drive the real `renderPortalSection` and assert on what
 * `redirect()` was called with, so they fail if the ordering regresses again —
 * a source-shape assertion could not.
 */

class RedirectError extends Error {
  constructor(public readonly to: string) {
    super(`NEXT_REDIRECT ${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const residentAccess = {
  applicationApproved: false,
  leaseAccessUnlocked: false,
  leaseSigned: false,
  fullPortalAccess: false,
  hasSubmittedApplication: false,
  hasCompletedApplicationSubmission: false,
  hasTourLink: false,
  pipelineOrder: "application_then_lease",
  hasLeaseFirstDraft: false,
  leaseFirstPendingLeaseId: null as string | null,
};

vi.mock("@/lib/auth/effective-session", () => ({
  getEffectiveSessionForPortal: vi.fn(async () => ({
    user: { id: "resident-1", email: "resident@example.com" },
    profile: { role: "resident", email: "resident@example.com", manager_id: null },
  })),
  getEffectiveUserIdForPortal: vi.fn(async () => "resident-1"),
}));

vi.mock("@/lib/resident-portal-access", async () => {
  const nav = await import("@/lib/resident-portal-nav");
  return {
    loadResidentPortalAccessState: vi.fn(async () => residentAccess),
    loadResidentLeaseSignedStatus: vi.fn(async () => false),
    residentPortalHomePath: nav.residentPortalHomePath,
  };
});

vi.mock("@/lib/manager-access-server", () => ({
  getManagerSubscriptionTier: vi.fn(async () => "paid"),
  getManagerSubscriptionTierByManagerId: vi.fn(async () => "paid"),
}));

vi.mock("@/lib/sms-comm-ui-flag.server", () => ({
  isSmsCommUiEnabled: vi.fn(async () => false),
}));

vi.mock("@/lib/auth/server-profile", () => ({
  getServerSessionProfile: vi.fn(async () => ({ profile: null, user: null })),
}));

// Imported at module scope, AFTER the vi.mock calls above (which are hoisted),
// so the whole render-portal-section graph's transform cost is paid once at
// collection time instead of being billed to the first test's timeout.
const { renderPortalSection } = await import("@/lib/render-portal-section");

/** Runs renderPortalSection and returns the path it redirected to. */
async function redirectTargetFor(
  section: string,
  tabParts?: string[],
  searchParams?: Record<string, string>,
): Promise<string> {
  try {
    await renderPortalSection("resident", section, tabParts, searchParams);
  } catch (error) {
    if (error instanceof RedirectError) return error.to;
    throw error;
  }
  throw new Error(`expected a redirect for /resident/${section}`);
}

describe("resident legacy section redirects resolve before the stage guard", () => {
  beforeEach(() => {
    Object.assign(residentAccess, {
      applicationApproved: false,
      leaseAccessUnlocked: false,
      leaseSigned: false,
      hasSubmittedApplication: true,
      hasCompletedApplicationSubmission: true,
      hasTourLink: false,
    });
  });

  it("sends /resident/financials/summary to Payments, not the dashboard", async () => {
    expect(await redirectTargetFor("financials", ["summary"])).toBe("/resident/payments");
  });

  it("keeps the status pill when a legacy financials tab maps to one", async () => {
    expect(await redirectTargetFor("financials", ["overdue"])).toBe("/resident/payments?status=overdue");
  });

  it("preserves the incoming query string across the financials redirect", async () => {
    expect(await redirectTargetFor("financials", ["balance"], { chargeId: "c-1" })).toBe(
      "/resident/payments?chargeId=c-1",
    );
  });

  it("sends /resident/finances to Payments through the financials alias", async () => {
    // `finances` redirects to `financials/summary`, which must itself resolve.
    expect(await redirectTargetFor("finances")).toBe("/resident/financials/summary");
    expect(await redirectTargetFor("financials", ["summary"])).toBe("/resident/payments");
  });

  it("sends the legacy /resident/inbox deep link to Communication", async () => {
    expect(await redirectTargetFor("inbox", ["unopened"])).toBe("/resident/communication/email/unopened");
  });

  it("defaults a bare /resident/inbox to the unopened folder", async () => {
    expect(await redirectTargetFor("inbox")).toBe("/resident/communication/email/unopened");
  });

  it("sends /resident/bugs-feedback to Settings", async () => {
    expect(await redirectTargetFor("bugs-feedback")).toBe("/resident/profile");
  });

  it("still resolves the legacy aliases for a brand-new pre-application resident", async () => {
    // The stage guard is strictest here (nothing but tour/applications/dashboard
    // /communication is unlocked), so this is the case that regressed first.
    Object.assign(residentAccess, { hasSubmittedApplication: false, hasCompletedApplicationSubmission: false });
    expect(await redirectTargetFor("inbox", ["unopened"])).toBe("/resident/communication/email/unopened");
    expect(await redirectTargetFor("bugs-feedback")).toBe("/resident/profile");
    expect(await redirectTargetFor("financials", ["summary"])).toBe("/resident/payments");
  });

  it("still guards a real section the resident's stage has not unlocked", async () => {
    // The guard is not weakened — only reordered. `/resident/lease` is not a
    // legacy alias, so a pre-approval resident is still sent home.
    Object.assign(residentAccess, { hasSubmittedApplication: false, hasCompletedApplicationSubmission: false });
    expect(await redirectTargetFor("lease")).toBe("/resident/applications/apply");
  });
});

describe("lease first is gone: stale lease-first flags change nothing", () => {
  beforeEach(() => {
    Object.assign(residentAccess, {
      applicationApproved: false,
      leaseAccessUnlocked: false,
      leaseSigned: false,
      hasSubmittedApplication: true,
      hasCompletedApplicationSubmission: false,
      hasTourLink: false,
      pipelineOrder: "lease_then_application",
      hasLeaseFirstDraft: true,
      leaseFirstPendingLeaseId: "lease_first_abc",
    });
  });

  it("Application never redirects to a lease", async () => {
    expect(await redirectTargetFor("applications")).toBe("/resident/applications/pending");
    await expect(renderPortalSection("resident", "applications", ["pending"])).resolves.toBeDefined();
  });

  it("Lease stays locked until an application is approved", async () => {
    expect(await redirectTargetFor("lease")).toBe("/resident/dashboard");
  });

  it("once the lease is signed, Application is the resident's again", async () => {
    Object.assign(residentAccess, { leaseFirstPendingLeaseId: null });
    expect(await redirectTargetFor("applications")).toBe("/resident/applications/pending");
  });

  it("application-first workspaces are untouched", async () => {
    Object.assign(residentAccess, {
      pipelineOrder: "application_then_lease",
      hasLeaseFirstDraft: false,
      leaseFirstPendingLeaseId: null,
    });
    expect(await redirectTargetFor("applications")).toBe("/resident/applications/pending");
    // Lease is still locked until approval.
    expect(await redirectTargetFor("lease")).toBe("/resident/dashboard");
  });
});

/**
 * C1-R5 — resident Inspections is a tab of My home now, not a sidebar section. Every old
 * `/resident/inspections/*` address (reminder emails, push deep links, bookmarks) must still land
 * on it, resolved before the stage guard like every other legacy alias.
 */
describe("resident Inspections moved into My home", () => {
  const signedLease = {
    applicationApproved: true,
    leaseAccessUnlocked: true,
    leaseSigned: true,
    hasSubmittedApplication: true,
    hasCompletedApplicationSubmission: true,
  };
  const reportId = "0b7d3c1e-5f2a-4c8e-9a41-2d6e8f1a7b30";

  beforeEach(() => {
    Object.assign(residentAccess, signedLease);
  });

  it("sends a bare /resident/inspections to the My home Inspections tab", async () => {
    expect(await redirectTargetFor("inspections")).toBe("/resident/move-in/inspections");
  });

  it("sends the old bucket lists to the merged list, keeping an explicit type", async () => {
    expect(await redirectTargetFor("inspections", ["upcoming"])).toBe("/resident/move-in/inspections");
    expect(await redirectTargetFor("inspections", ["done"], { type: "move-out" })).toBe(
      "/resident/move-in/inspections/move-out",
    );
  });

  it("keeps a kind list and a single filed report addressable", async () => {
    expect(await redirectTargetFor("inspections", ["move-in"])).toBe("/resident/move-in/inspections/move-in");
    expect(await redirectTargetFor("inspections", ["move-in", reportId])).toBe(
      `/resident/move-in/inspections/move-in/${reportId}`,
    );
  });

  it.each([["reports"], ["pending"], ["upcoming"], ["in-progress"], ["done"], ["reports", "anything"]])(
    "sends the retired /resident/inspections/%s list address to the merged list, never a 404",
    async (...parts) => {
      expect(await redirectTargetFor("inspections", parts)).toBe("/resident/move-in/inspections");
    },
  );

  it.each([
    [undefined],
    [["reports"]],
    [["pending"]],
    [["done"]],
    [["move-in"]],
    [["move-out"]],
    [["move-in", reportId]],
  ])("every legacy /resident/inspections/* redirect lands on a route that resolves (%j)", async (parts) => {
    const target = await redirectTargetFor("inspections", parts);
    expect(routeResolves(target)).toBe(true);
    const [, , section, ...tab] = target.split("/");
    // ...and the page behind it renders instead of calling notFound().
    await expect(renderPortalSection("resident", section!, tab)).resolves.toBeDefined();
  });

  it("resolves for a resident who has not signed yet (the new address then judges them)", async () => {
    Object.assign(residentAccess, { applicationApproved: false, leaseAccessUnlocked: false, leaseSigned: false });
    expect(await redirectTargetFor("inspections")).toBe("/resident/move-in/inspections");
    // ...and the stage guard holds Inspections back: an approved resident gets Forms alone.
    Object.assign(residentAccess, { applicationApproved: true });
    expect(await redirectTargetFor("move-in", ["inspections"])).toBe("/resident/dashboard");
  });

  it("renders the Inspections tab inside My home once the lease is signed", async () => {
    const node = (await renderPortalSection("resident", "move-in", ["inspections"])) as { props: Record<string, unknown> };
    expect(node.props.tabId).toBe("inspections");
    expect(node.props.inspectionsTypeFilter).toBeUndefined();
    const typed = (await renderPortalSection("resident", "move-in", ["inspections", "move-out"])) as { props: Record<string, unknown> };
    expect(typed.props.inspectionsTypeFilter).toBe("move-out");
  });

  it("opens a single report on its own page and rejects malformed addresses", async () => {
    const node = (await renderPortalSection("resident", "move-in", ["inspections", "move-in", reportId])) as { props: Record<string, unknown> };
    expect(node.props.reportId).toBe(reportId);
    expect(node.props.kind).toBe("move-in");
    await expect(renderPortalSection("resident", "move-in", ["inspections", "sideways"])).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(renderPortalSection("resident", "move-in", ["inspections", "move-in", "not-a-uuid"])).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(renderPortalSection("resident", "move-in", ["inspections", "move-in", reportId, "extra"])).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("keeps the retired Amenities address alive under Move-in details", async () => {
    expect(await redirectTargetFor("move-in", ["amenities"])).toBe("/resident/move-in/info");
  });
});
