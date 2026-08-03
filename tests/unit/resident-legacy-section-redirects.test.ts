import { beforeEach, describe, expect, it, vi } from "vitest";

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
