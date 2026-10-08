// Every URL the vendor IA slice moved still lands somewhere real (AGENTS.md § Portal routing precedence).
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

const { renderPortalSection } = await import("@/lib/render-portal-section/vendor");

async function landing(section: string, tabParts?: string[], searchParams?: Record<string, string>) {
  try {
    await renderPortalSection("vendor", section, tabParts, searchParams);
  } catch (e) {
    if (e instanceof RedirectError) return e.to;
    throw e;
  }
  return "rendered";
}

describe("vendor Calendar / Settings moved URLs", () => {
  it("every retired /vendor/calendar/<tab> lands on /vendor/calendar", async () => {
    for (const tab of ["all", "services", "availability", "week", "day", "month", "list", "tasks", "tours", "anything"]) {
      expect(await landing("calendar", [tab]), tab).toBe("/vendor/calendar");
    }
    expect(await landing("calendar", ["services", "extra"])).toBe("/vendor/calendar");
  });

  it("the bare /vendor/calendar renders (no redirect loop)", async () => {
    expect(await landing("calendar")).toBe("rendered");
  });

  it("/vendor/profile?tab=availability and /vendor/settings availability land on the Weekly hours pop-up", async () => {
    expect(await landing("profile", undefined, { tab: "availability" })).toBe("/vendor/calendar?modal=weekly-hours");
    expect(await landing("settings", ["availability"])).toBe("/vendor/calendar?modal=weekly-hours");
    expect(await landing("settings", undefined, { tab: "availability" })).toBe("/vendor/calendar?modal=weekly-hours");
  });
});
