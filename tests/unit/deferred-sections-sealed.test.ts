// A deferred section must be unreachable by URL, not merely hidden in the nav.
//
// Locking a section in `portalNavLockKind` stops the sidebar row from navigating, but that is
// only the door. Typing `/portal/<section>`, following an old bookmark, or clicking a link in an
// older email still rendered the half-built surface the lock exists to keep people out of —
// and AGENTS.md is explicit that a locked row must never point at a path the server still
// serves. `renderPortalSection` closes the server half.
//
// Asserted against the source because the redirect happens inside a server component: there is
// no client-side state to observe, and importing the renderer would pull the whole portal tree.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFERRED_SECTIONS, portalNavLockKind } from "@/lib/portals/nav-locks";

const RENDERER = readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8");

describe("deferred sections", () => {
  it("has no deferred sections while payments is live", () => {
    expect(DEFERRED_SECTIONS.has("payments")).toBe(false);
    expect(DEFERRED_SECTIONS.size).toBe(0);
  });

  it("does not inert-lock payments for any role or plan", () => {
    for (const kind of ["manager", "pro", "resident"] as const) {
      for (const tier of ["free", "paid", null] as const) {
        expect(portalNavLockKind({ kind, section: "payments", subscriptionTier: tier })).toBe("none");
      }
    }
  });

  it("does not lock anything it was not asked to", () => {
    for (const section of ["dashboard", "leases", "applications", "communication", "services", "payments"]) {
      expect(portalNavLockKind({ kind: "manager", section, subscriptionTier: "paid" })).toBe("none");
    }
  });

  it("the renderer still guards deferred sections when the set is non-empty", () => {
    expect(RENDERER).toContain("DEFERRED_SECTIONS.has(section)");
  });

  it("redirects BEFORE the legacy rewrites, so nothing can land inside a deferred section", () => {
    const guard = RENDERER.indexOf("DEFERRED_SECTIONS.has(section)");
    const stripeRewrite = RENDERER.indexOf('section === "stripe"');
    const financesRewrite = RENDERER.indexOf('section === "finances"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(stripeRewrite);
    expect(guard).toBeLessThan(financesRewrite);
  });
});
