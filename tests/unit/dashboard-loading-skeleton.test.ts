import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * Night UX sweep — Manager Dashboard rendered fully blank on phone
 * (`pro-dashboard.tsx` did `if (!data) return null` with no fallback) and
 * Resident Dashboard showed the same empty-below-header symptom. Both must
 * show a shape-matched skeleton while loading and a retry card on genuine
 * failure, never nothing.
 */
describe("dashboard loading never blanks the page", () => {
  it("manager dashboard shows a skeleton while the session resolves, and a retry card on failure, before any zero-state UI", () => {
    const src = read("src/components/portal/pro-dashboard.tsx");
    expect(src).toContain("DashboardSkeleton");
    expect(src).toContain("DashboardLoadError");
    // Loading and failure are both wrapped in the real page shell so the
    // title/nav context never disappears either.
    const skeletonBranch = src.slice(src.indexOf("if (!authReady)"), src.indexOf("if (!data) {"));
    expect(skeletonBranch).toContain("ManagerPortalPageShell");
    expect(skeletonBranch).toContain("<DashboardSkeleton");
  });

  it("resident dashboard shows the same skeleton while the client/session are not ready, instead of rendering an all-conditional blank body", () => {
    const src = read("src/components/portal/resident-dashboard.tsx");
    expect(src).toContain("DashboardSkeleton");
    expect(src).toContain("dashboardReady");
    // The skeleton branch must gate on BOTH the one-tick client mount and the
    // portal session, matching the two flags the blank capture depended on.
    expect(src).toMatch(/dashboardReady\s*=\s*clientReady\s*&&\s*session\.ready/);
  });
});
