import { describe, expect, it } from "vitest";
import {
  portalNavLockKind,
  portalNavLockNavigable,
  portalNavSectionLocked,
} from "@/lib/portals/nav-locks";

/**
 * A lock is not the same thing as a dead click.
 *
 * The resident redesign made EVERY locked nav row a non-navigating <span>, for
 * every portal kind. That silently deleted the only sidebar entry point to
 * `PortalTierPaywall`, so a free-tier manager had no way left to reach the
 * upgrade page. Locks still apply to manager free-tier sections — what changed
 * back is what clicking one does.
 */
describe("portal nav lock kinds", () => {
  describe("manager / pro free tier — locked but still sells the upgrade", () => {
    for (const kind of ["manager", "pro"] as const) {
      it(`${kind}: a paid-only section is an upsell lock`, () => {
        const params = { kind, section: "leases", subscriptionTier: "free" as const };
        expect(portalNavLockKind(params)).toBe("upsell");
        expect(portalNavSectionLocked(params)).toBe(true);
        // The click must still land on the PortalTierPaywall page.
        expect(portalNavLockNavigable(params)).toBe(true);
      });

      it(`${kind}: financials and documents are locked on Free`, () => {
        for (const section of ["financials", "documents", "services", "communication"]) {
          expect(portalNavLockKind({ kind, section, subscriptionTier: "free" })).toBe("upsell");
        }
      });

      it(`${kind}: free-tier sections are not locked at all`, () => {
        // "payments" is deliberately absent: it is a DEFERRED section now, locked inert for
        // every viewer and every plan until the flows around it are finished.
        for (const section of ["dashboard", "properties", "applications", "calendar", "profile"]) {
          expect(portalNavLockKind({ kind, section, subscriptionTier: "free" })).toBe("none");
        }
      });

      it(`${kind}: payments stays locked even on a paid plan (deferred, not a tier gate)`, () => {
        expect(portalNavLockKind({ kind, section: "payments", subscriptionTier: "paid" })).toBe("inert");
        expect(portalNavLockKind({ kind, section: "payments", subscriptionTier: "free" })).toBe("inert");
      });

      it(`${kind}: nothing is locked on a paid plan`, () => {
        for (const section of ["leases", "financials", "documents", "services"]) {
          expect(portalNavLockKind({ kind, section, subscriptionTier: "paid" })).toBe("none");
          expect(portalNavLockKind({ kind, section, subscriptionTier: null })).toBe("none");
        }
      });
    }
  });

  describe("resident — locks are inert, because there is nothing to buy", () => {
    it("stage locks are inert", () => {
      const params = {
        kind: "resident" as const,
        section: "lease",
        subscriptionTier: "paid" as const,
        residentNavStage: "pre_approval" as const,
      };
      expect(portalNavLockKind(params)).toBe("inert");
      expect(portalNavSectionLocked(params)).toBe(true);
      expect(portalNavLockNavigable(params)).toBe(false);
    });

    it("keeps a not-yet-reached stage's sections locked", () => {
      // Tour and Applications stay UNLOCKED after approval (upstream
      // "Keep resident Tour and Application nav unlocked after approval"), so
      // the stage lock is about sections the resident has not reached yet.
      for (const section of ["services", "move-in"]) {
        expect(
          portalNavLockKind({
            kind: "resident",
            section,
            subscriptionTier: "paid",
            residentNavStage: "post_approval_pre_lease",
          }),
        ).toBe("inert");
      }
    });

    it("a free-tier MANAGER plan still locks the resident's section, inertly", () => {
      // The resident cannot upgrade their manager's plan, so the row is a
      // no-op — same behaviour as a stage lock, so a lock reads one way.
      const params = {
        kind: "resident" as const,
        section: "services",
        subscriptionTier: "free" as const,
        residentNavStage: "post_lease" as const,
      };
      expect(portalNavLockKind(params)).toBe("inert");
      expect(portalNavLockNavigable(params)).toBe(false);
    });

    it("unlocked resident sections are not locked", () => {
      for (const section of ["dashboard", "communication", "profile", "tour", "applications"]) {
        expect(
          portalNavLockKind({
            kind: "resident",
            section,
            subscriptionTier: "paid",
            residentNavStage: "pre_approval",
          }),
        ).toBe("none");
      }
    });

    it("tour stays unlocked for approved residents even on a free manager plan", () => {
      expect(
        portalNavLockKind({
          kind: "resident",
          section: "tour",
          subscriptionTier: "free",
          residentNavStage: "post_approval_pre_lease",
        }),
      ).toBe("none");
    });

    it("never returns upsell for a resident, at any stage or tier", () => {
      for (const stage of ["pre_approval", "post_approval_pre_lease", "post_lease"] as const) {
        for (const tier of ["free", "paid", null] as const) {
          for (const section of ["lease", "services", "documents", "tour", "applications", "payments"]) {
            expect(
              portalNavLockKind({ kind: "resident", section, subscriptionTier: tier, residentNavStage: stage }),
            ).not.toBe("upsell");
          }
        }
      }
    });
  });

  it("locks nothing for portals with no tier or stage model", () => {
    for (const kind of ["admin", "vendor"] as const) {
      expect(portalNavLockKind({ kind, section: "financials", subscriptionTier: "free" })).toBe("none");
    }
  });
});
