// @vitest-environment jsdom
//
// End-to-end render proof for the dogfood account that shipped broken: a
// resident who is ALSO a manager (`profiles.role = "manager"`,
// `profile_roles = [manager, resident]`) with an APPROVED application and a
// fully signed lease.
//
// The bug was invisible in component tests because the component was fine — the
// resolver handed it `emptyAccessState`, which resolves to nav stage
// `pre_approval`, so Lease / Payments / Documents / Services rendered as
// padlocked dead rows and a lease that had really been sent was unreachable.
//
// This drives the REAL `loadResidentPortalAccessState` (only the Supabase
// service client is stubbed) into the REAL `PortalSidebar`, exactly as
// `src/app/resident/layout.tsx` wires them, and asserts what the resident sees.
//
// Set `RESIDENT_UNLOCK_EVIDENCE_OUT=<path>` to also dump the rendered sidebar
// HTML for a reviewer-visible screenshot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
// Not on this path (only `resolveResidentScopedActorRole` reads it); stubbed so
// the jsdom environment never has to resolve its `server-only` import.
vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: async () => ({ roles: ["manager", "resident"], effectiveRole: "resident" }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "dogfood-user", email: "dogfood@example.com", ready: true }),
}));
vi.mock("@/hooks/use-portal-nav-counts", () => ({ usePortalNavCounts: () => ({}) }));
vi.mock("@/hooks/use-co-manager-nav-sections", () => ({
  // Mirror the hook's real return shape — the sidebar destructures
  // `{ sections, restrictedSections }`, so handing back a bare array leaves
  // `visibleSections` undefined and the render dies inside a useMemo.
  useCoManagerNavSections: (definition: { sections: unknown[] }) => ({
    sections: definition.sections,
    restrictedSections: new Set<string>(),
  }),
}));
vi.mock("@/hooks/use-is-native-app", () => ({
  useNativeChrome: () => false,
  useIsSmallPortalViewport: () => false,
  useIsNativeApp: () => ({ isNative: false, platform: null }),
}));
vi.mock("@/lib/portal-nav-prefetch", () => ({
  portalMobileLinkPrefetchEnabled: () => false,
  portalBackgroundPrefetchEnabled: () => false,
}));
vi.mock("@/lib/portal-nav-client", () => ({
  isCrossPortalNavigation: () => false,
  portalNavClick: () => () => {},
  prefetchPortalHref: () => {},
  usePortalNavigate: () => () => {},
}));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadResidentPortalAccessState } from "@/lib/resident-portal-access";
import {
  isResidentPathAllowedForAccess,
  resolveResidentPortalNavStage,
} from "@/lib/resident-portal-nav";
import { getResidentPortalDefinition } from "@/lib/portals/resident";
import { PortalSidebar } from "@/components/portal/portal-sidebar";

// jsdom ships no scrollIntoView; the sidebar centres the active mobile tab with it.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const RESIDENT_EMAIL = "dogfood@example.com";
const RESIDENT_USER_ID = "dogfood-user";

/** The approved application + fully signed lease this account really has. */
const APPROVED_APPLICATION = {
  resident_email: RESIDENT_EMAIL,
  updated_at: "2026-07-01T12:00:00.000Z",
  row_data: {
    id: "APP-1",
    email: RESIDENT_EMAIL,
    bucket: "approved",
    stage: "Approved",
    property: "Cedar House · Unit 2",
  },
};

const SIGNED_LEASE_ROW = {
  row_data: {
    residentEmail: RESIDENT_EMAIL,
    managerSignature: { name: "Prakrit R", signedAtIso: "2026-07-02T17:00:00.000Z" },
    residentSignature: { name: "Dogfood Resident", signedAtIso: "2026-07-02T18:30:00.000Z" },
  },
};

/**
 * Supabase stub for the multi-role dogfood account:
 * legacy `profiles.role = "manager"`, `profile_roles = [manager, resident]`.
 */
function makeMultiRoleDb() {
  const profileRoles = ["manager", "resident"];
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "manager_application_records") {
        return {
          select: vi.fn().mockImplementation((_cols: string, opts?: { head?: boolean }) => {
            if (opts?.head) return { eq: vi.fn().mockResolvedValue({ count: 1, error: null }) };
            return {
              eq: vi.fn().mockImplementation((col: string) => {
                if (col === "id") {
                  return { maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
                }
                return {
                  order: vi.fn().mockResolvedValue({ data: [APPROVED_APPLICATION], error: null }),
                };
              }),
            };
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi
                .fn()
                .mockResolvedValue({ data: { application_approved: true, manager_id: null }, error: null }),
            }),
          }),
        };
      }
      if (table === "profile_roles") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockImplementation(() => ({
              eq: vi.fn().mockImplementation((_col: string, value: string) => ({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: profileRoles.includes(value) ? { role: value } : null,
                  error: null,
                }),
              })),
              order: vi.fn().mockResolvedValue({
                data: profileRoles.map((role) => ({ role })),
                error: null,
              }),
            })),
          }),
        };
      }
      if (table === "resident_tour_links") {
        return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ count: 0, error: null }) }) };
      }
      if (table === "portal_lease_pipeline_records") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: [SIGNED_LEASE_ROW], error: null }),
            }),
          }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({ data: [], error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
    }),
  };
}

const PREVIOUSLY_LOCKED = ["Lease", "Payments", "Documents", "Services"] as const;

afterEach(cleanup);

describe("manager+resident dogfood account sees an unlocked resident portal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(makeMultiRoleDb() as never);
  });

  it("renders Lease / Payments / Documents / Services as live rows, not padlocks", async () => {
    // Exactly what src/app/resident/layout.tsx does.
    const access = await loadResidentPortalAccessState({
      userId: RESIDENT_USER_ID,
      role: "manager", // legacy `profiles.role` for an account created as a manager
      email: RESIDENT_EMAIL,
    });
    const stage = resolveResidentPortalNavStage(access);
    const definition = await getResidentPortalDefinition();

    const { container } = render(
      <PortalSidebar definition={definition} subtitle="Resident" residentNavStage={stage} />,
    );
    // The desktop sidebar; the same component also renders the mobile strip and
    // bottom bar, which repeat every label.
    const aside = container.querySelector("aside");
    if (!aside) throw new Error("desktop sidebar did not render");
    const sidebar = within(aside);

    const evidenceOut = process.env.RESIDENT_UNLOCK_EVIDENCE_OUT;
    if (evidenceOut) {
      const { writeFileSync } = await import("node:fs");
      // An inert (locked) resident row renders as a `role="link"` <span> with no
      // href, so collect both shapes.
      const links = [...aside.querySelectorAll('a, [role="link"]')];
      const rows = PREVIOUSLY_LOCKED.map((label) => {
        // Locked rows keep the label as visible text but rename the accessible
        // label to "<Label>: <lock reason>", so match on the row's own text.
        const link = links.find((a) => (a.textContent ?? "").trim().startsWith(label)) ?? null;
        return {
          label,
          href: link?.getAttribute("href") ?? null,
          ariaLabel: link?.getAttribute("aria-label") ?? null,
          ariaDisabled: link?.getAttribute("aria-disabled") ?? null,
          locked: Boolean(link?.querySelector("svg rect[y='11']")),
        };
      });
      writeFileSync(
        evidenceOut,
        JSON.stringify(
          {
            access: {
              roleOk: access.roleOk,
              applicationApproved: access.applicationApproved,
              leaseSigned: access.leaseSigned,
              leaseAccessUnlocked: access.leaseAccessUnlocked,
              fullPortalAccess: access.fullPortalAccess,
            },
            stage,
            leasePathAllowed: isResidentPathAllowedForAccess("/resident/lease", access),
            rows,
            sidebarHtml: aside.outerHTML,
          },
          null,
          2,
        ),
      );
    }

    expect(access.roleOk).toBe(true);
    expect(access.applicationApproved).toBe(true);
    expect(access.leaseAccessUnlocked).toBe(true);
    expect(stage).toBe("post_lease");
    expect(isResidentPathAllowedForAccess("/resident/lease", access)).toBe(true);

    for (const label of PREVIOUSLY_LOCKED) {
      const row = sidebar.getByRole("link", { name: label });
      expect(row.getAttribute("aria-disabled")).toBeNull();
      expect(row.getAttribute("href")).not.toBe("#");
    }
    expect(sidebar.queryByRole("link", { name: /\(locked\)/ })).toBeNull();
  });
});
