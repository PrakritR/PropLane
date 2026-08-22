// A deferred section must be unreachable by URL, not merely hidden in the nav.
//
// Locking `payments` in `portalNavLockKind` stops the sidebar row from navigating, but that is
// only the door. Typing `/portal/payments`, following an old bookmark, or clicking a link in an
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
  it("payments is deferred", () => {
    expect(DEFERRED_SECTIONS.has("payments")).toBe(true);
  });

  it("is locked inert for every role and plan", () => {
    for (const kind of ["manager", "pro", "resident"] as const) {
      for (const tier of ["free", "paid", null] as const) {
        expect(portalNavLockKind({ kind, section: "payments", subscriptionTier: tier })).toBe("inert");
      }
    }
  });

  it("does not lock anything it was not asked to", () => {
    // A deferral must not quietly take out a neighbouring section.
    for (const section of ["dashboard", "leases", "applications", "communication", "services"]) {
      expect(portalNavLockKind({ kind: "manager", section, subscriptionTier: "paid" })).toBe("none");
    }
  });

  it("the renderer redirects a deferred section away", () => {
    expect(RENDERER).toContain("DEFERRED_SECTIONS.has(section)");
  });

  it("redirects BEFORE the legacy rewrites, so nothing can land inside a deferred section", () => {
    // `stripe` -> `payments` is exactly that case: an earlier redirect targeting a section that
    // is now deferred. The guard only holds if it runs first.
    const guard = RENDERER.indexOf("DEFERRED_SECTIONS.has(section)");
    const stripeRewrite = RENDERER.indexOf('section === "stripe"');
    const financesRewrite = RENDERER.indexOf('section === "finances"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(stripeRewrite);
    expect(guard).toBeLessThan(financesRewrite);
  });
});
