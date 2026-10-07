/**
 * `/portal/settings` is a redirect into the Profile hub. The old query form
 * (`?tab=inspections`) is honored, and every OTHER query param rides along — so
 * the page component has to hand `searchParams` to `renderPortalSection`, the
 * same way the vendor page does.
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

const PortalSectionPage = (await import("@/app/portal/[section]/[[...tab]]/page")).default;
const { resolveSettingsRedirectHubTab } = await import("@/lib/portal-settings-section");

async function target(tab: string[] | undefined, searchParams?: Record<string, string>) {
  try {
    await PortalSectionPage({
      params: Promise.resolve({ section: "settings", tab }),
      searchParams: searchParams ? Promise.resolve(searchParams) : undefined,
    });
  } catch (e) {
    if (e instanceof RedirectError) return e.to;
    throw e;
  }
  throw new Error("expected redirect");
}

describe("/portal/settings?tab= through the page component", () => {
  it("honors the query tab", async () => {
    const hub = resolveSettingsRedirectHubTab("inspections");
    expect(hub).toBeTruthy();
    expect(await target(undefined, { tab: "inspections" })).toBe(`/portal/profile?tab=${hub}`);
  });

  it("carries the other query params along", async () => {
    const to = await target(undefined, { tab: "inspections", from: "email" });
    expect(to.startsWith("/portal/profile?")).toBe(true);
    const q = new URLSearchParams(to.split("?")[1]);
    expect(q.get("from")).toBe("email");
    expect(q.get("tab")).toBe(resolveSettingsRedirectHubTab("inspections"));
  });

  it("a path segment still wins over the query", async () => {
    const hub = resolveSettingsRedirectHubTab("bookings");
    expect(await target(["bookings"], { tab: "inspections" })).toBe(`/portal/profile?tab=${hub}`);
  });

  it("no searchParams at all still resolves the default hub tab", async () => {
    expect(await target(undefined)).toBe(`/portal/profile?tab=${resolveSettingsRedirectHubTab(null)}`);
  });
});
