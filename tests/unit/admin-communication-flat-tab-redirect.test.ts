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

vi.mock("@/lib/auth/effective-session", () => ({
  getEffectiveSessionForPortal: vi.fn(async () => ({
    user: { id: "admin-1", email: "admin@prop-lane.space" },
    profile: { role: "admin", email: "admin@prop-lane.space", manager_id: null },
  })),
  getEffectiveUserIdForPortal: vi.fn(async () => "admin-1"),
}));

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

const { renderPortalSection } = await import("@/lib/render-portal-section");

async function redirectTargetFor(tabParts?: string[]): Promise<string> {
  try {
    await renderPortalSection("admin", "communication", tabParts);
  } catch (error) {
    if (error instanceof RedirectError) return error.to;
    throw error;
  }
  throw new Error("expected a redirect for /admin/communication");
}

describe("admin communication flat inbox tab paths", () => {
  it("redirects /admin/communication/schedule to the canonical inbox route", async () => {
    expect(await redirectTargetFor(["schedule"])).toBe("/admin/communication/inbox/schedule");
  });

  it("redirects other flat inbox tabs to /admin/communication/inbox/{tab}", async () => {
    expect(await redirectTargetFor(["unopened"])).toBe("/admin/communication/inbox/unopened");
    expect(await redirectTargetFor(["sent"])).toBe("/admin/communication/inbox/sent");
    expect(await redirectTargetFor(["trash"])).toBe("/admin/communication/inbox/trash");
  });

  it("rejects nested paths under a flat tab segment", async () => {
    await expect(redirectTargetFor(["schedule", "extra"])).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
