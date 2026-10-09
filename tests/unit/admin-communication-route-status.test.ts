import { describe, expect, it, vi } from "vitest";

/**
 * PRP-184 finding 11 — a legacy admin Communication path soft-404'd: it rendered a not-found
 * page with HTTP **200** while a canonical path existed.
 *
 * A 200 on a missing page is a correctness bug rather than a design one: it lies to crawlers,
 * to uptime monitoring, and to anyone reading logs for broken links. What makes it easy to
 * reintroduce is that both outcomes look identical in a browser — you see a not-found page
 * either way — so it is asserted here on the ROUTE's behaviour instead.
 *
 * Admin Communication is the manager's page (Active | Archived, `/communication/{segment}
 * [/{threadId}]`). The old folder paths (unopened / opened / schedule / sent / trash) still
 * resolve by redirecting to the segment they became: trash is Archived, every other folder is
 * the one Active list. Redirecting (not rendering) is the correct answer for a legacy path that
 * has a canonical home, and `notFound()` — which Next serves as a real 404 — for one that does not.
 */

class RedirectError extends Error {
  constructor(public readonly to: string) {
    super(`NEXT_REDIRECT ${to}`);
  }
}
class NotFoundError extends Error {}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
  notFound: () => {
    throw new NotFoundError("NEXT_NOT_FOUND");
  },
}));

vi.mock("@/lib/auth/effective-session", () => ({
  getEffectiveSessionForPortal: vi.fn(async () => ({
    user: { id: "admin-1", email: "admin@example.com" },
    profile: { role: "admin", email: "admin@example.com", manager_id: null },
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

const { renderPortalSection } = await import("@/lib/render-portal-section/admin");

type Outcome = { kind: "redirect"; to: string } | { kind: "notFound" } | { kind: "rendered" };

async function outcomeFor(section: string, tabParts?: string[]): Promise<Outcome> {
  try {
    await renderPortalSection("admin", section, tabParts);
    return { kind: "rendered" };
  } catch (error) {
    if (error instanceof RedirectError) return { kind: "redirect", to: error.to };
    if (error instanceof NotFoundError) return { kind: "notFound" };
    throw error;
  }
}

describe("admin communication route status", () => {
  it("redirects the legacy schedule path to the Active list", async () => {
    // The finding: this used to RENDER a not-found page, which Next serves with a 200.
    expect(await outcomeFor("communication", ["schedule"])).toEqual({
      kind: "redirect",
      to: "/admin/communication/active",
    });
  });

  it("redirects the legacy inbox folder paths to the segment they became", async () => {
    expect(await outcomeFor("communication", ["inbox", "schedule"])).toEqual({
      kind: "redirect",
      to: "/admin/communication/active",
    });
    for (const tab of ["unopened", "opened", "sent"]) {
      expect(await outcomeFor("communication", ["inbox", tab])).toEqual({
        kind: "redirect",
        to: "/admin/communication/active",
      });
    }
    expect(await outcomeFor("communication", ["inbox", "trash"])).toEqual({
      kind: "redirect",
      to: "/admin/communication/archived",
    });
  });

  it("redirects every flat folder path the same way", async () => {
    for (const tab of ["unopened", "opened", "sent"]) {
      expect(await outcomeFor("communication", [tab])).toEqual({
        kind: "redirect",
        to: "/admin/communication/active",
      });
    }
    expect(await outcomeFor("communication", ["trash"])).toEqual({
      kind: "redirect",
      to: "/admin/communication/archived",
    });
  });

  it("renders the Active and Archived segments, with or without an open conversation", async () => {
    expect(await outcomeFor("communication", ["active"])).toEqual({ kind: "rendered" });
    expect(await outcomeFor("communication", ["archived"])).toEqual({ kind: "rendered" });
    expect(await outcomeFor("communication", ["active", "thread-1"])).toEqual({ kind: "rendered" });
    expect(await outcomeFor("communication", ["archived", "thread-1"])).toEqual({ kind: "rendered" });
  });

  it("folds Unread into Active (Unread lives in Filter), as the manager route does", async () => {
    expect(await outcomeFor("communication", ["unread"])).toEqual({
      kind: "redirect",
      to: "/admin/communication/active",
    });
  });

  it("answers a genuinely unknown tab with a real 404, not a 200", async () => {
    expect(await outcomeFor("communication", ["nonsense-xyz"])).toEqual({ kind: "notFound" });
    expect(await outcomeFor("communication", ["inbox", "nonsense-xyz"])).toEqual({ kind: "notFound" });
  });

  it("refuses a path deeper than the inbox goes", async () => {
    expect(await outcomeFor("communication", ["inbox", "schedule", "extra"])).toEqual({ kind: "notFound" });
    expect(await outcomeFor("communication", ["active", "thread-1", "extra"])).toEqual({ kind: "notFound" });
  });

  it("renders the bare section as the inbox itself", async () => {
    expect(await outcomeFor("communication")).toEqual({ kind: "rendered" });
  });
});
