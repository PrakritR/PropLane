/**
 * Stripe sends the resident back to `/resident/payments?ach_checkout=return&session_id=…`,
 * which has no page of its own and redirects to the bucket. That redirect used to carry
 * `?pay=` alone, so the panel's verify effect never ran and a paid charge sat in Upcoming
 * until a webhook landed. The whole query rides through now.
 */
import { describe, expect, it, vi } from "vitest";

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

// A resident who has reached checkout: Payments is unlocked, so the stage guard lets the
// section through and the bucket redirect below is what answers.
const residentAccess = {
  applicationApproved: true,
  leaseAccessUnlocked: true,
  leaseSigned: true,
  fullPortalAccess: true,
  hasSubmittedApplication: true,
  hasCompletedApplicationSubmission: true,
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
    loadResidentLeaseSignedStatus: vi.fn(async () => true),
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

const { renderPortalSection } = await import("@/lib/render-portal-section/resident");

async function target(tabParts?: string[], searchParams?: Record<string, string>) {
  try {
    await renderPortalSection("resident", "payments", tabParts, searchParams);
  } catch (e) {
    if (e instanceof RedirectError) return e.to;
    throw e;
  }
  throw new Error("expected redirect");
}

describe("/resident/payments checkout return", () => {
  it("carries the Stripe return params onto the bucket route", async () => {
    const to = await target(undefined, { ach_checkout: "return", session_id: "cs_test_123" });
    expect(to.startsWith("/resident/payments/pending?")).toBe(true);
    const query = new URLSearchParams(to.slice(to.indexOf("?") + 1));
    expect(query.get("ach_checkout")).toBe("return");
    expect(query.get("session_id")).toBe("cs_test_123");
  });

  it("still opens a charge from ?pay= and still consumes the legacy ?status=", async () => {
    expect(await target(undefined, { pay: "hc_1" })).toBe("/resident/payments/pending?pay=hc_1");
    const to = await target(undefined, { status: "paid", session_id: "cs_1" });
    expect(to.startsWith("/resident/payments/paid?")).toBe(true);
    const query = new URLSearchParams(to.slice(to.indexOf("?") + 1));
    expect(query.get("status")).toBeNull();
    expect(query.get("session_id")).toBe("cs_1");
  });

  it("keeps the query when an unknown bucket is corrected", async () => {
    const to = await target(["nope"], { ach_checkout: "success", session_id: "cs_2" });
    expect(to.startsWith("/resident/payments/pending?")).toBe(true);
    expect(to).toContain("session_id=cs_2");
  });

  it("adds no query when there was none", async () => {
    expect(await target()).toBe("/resident/payments/pending");
  });
});
