import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { residentApplicationHandoffPath } from "@/lib/auth/resident-application-handoff-path";
import { isResidentPathAllowedForAccess } from "@/lib/resident-portal-nav";

describe("resident application verification continuation", () => {
  it("opens the application on a real bucket route without losing or injecting the id", () => {
    const url = new URL(residentApplicationHandoffPath("PROPLANE-1&other=2"), "https://local.invalid");
    expect(url.pathname).toBe("/resident/applications/pending");
    expect(url.searchParams.get("open")).toBe("PROPLANE-1&other=2");
    expect(url.searchParams.has("other")).toBe(false);
    expect(existsSync("src/app/resident/applications/[bucket]/page.tsx")).toBe(true);
    expect(readFileSync("src/components/portal/resident-applications-panel.tsx", "utf8")).toContain('searchParams.get("open")');
    expect(isResidentPathAllowedForAccess(url.pathname, { leaseAccessUnlocked: false, applicationApproved: false, hasSubmittedApplication: false, hasCompletedApplicationSubmission: false, hasTourLink: false, isPreLeaseResident: false })).toBe(true);
  });
});
