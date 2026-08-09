"use client";

import { AxisLogoLink } from "@/components/brand/axis-logo";
import { Navbar1, type NavbarMenuItem } from "@/components/ui/navbar1";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { portalDashboardPath, normalizePortalRoles, parseAuthRole, type AuthRole } from "@/lib/auth/portal-roles";
import { RESIDENT_BROWSE_PATH } from "@/lib/resident-public-nav";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { safeBrowserGetSession } from "@/lib/supabase/safe-browser-session";
import type { Session } from "@supabase/supabase-js";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

const AUTH_STORAGE_KEY = "axis:signed_in";

function readSignedInFromStorage(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(AUTH_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistSignedIn(value: boolean) {
  try {
    if (value) localStorage.setItem(AUTH_STORAGE_KEY, "1");
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {}
}

// One consistent label for every logged-in role — clicking it takes the user
// straight into their portal home (see portalLink below).
function portalLinkLabel(): string {
  return "Portal";
}

export function PublicNavbar() {
  const pathname = usePathname();
  const { isNative } = useIsNativeApp();
  const hideOnNative = isNative === true;
  const [signedIn, setSignedIn] = useState(false);
  const [primaryRole, setPrimaryRole] = useState<AuthRole | null>(null);

  useEffect(() => {
    queueMicrotask(() => setSignedIn(readSignedInFromStorage()));

    const supabase = createSupabaseBrowserClient();

    async function syncAuth(session: Session | null) {
      const isSignedIn = !!session;
      setSignedIn(isSignedIn);
      persistSignedIn(isSignedIn);
      if (!session) {
        setPrimaryRole(null);
        return;
      }

      const [{ data: profile }, { data: roleRows }] = await Promise.all([
        supabase.from("profiles").select("role").eq("id", session.user.id).maybeSingle(),
        supabase.from("profile_roles").select("role").eq("user_id", session.user.id),
      ]);
      const roles = normalizePortalRoles(roleRows, profile?.role ?? session.user.user_metadata?.role);
      setPrimaryRole(roles[0] ?? parseAuthRole(String(profile?.role ?? session.user.user_metadata?.role ?? "")));
    }

    void safeBrowserGetSession(supabase).then(({ session }) => {
      void syncAuth(session);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event: string, session: Session | null) => {
      void syncAuth(session);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const residentActive = useMemo(
    () =>
      pathname === RESIDENT_BROWSE_PATH ||
      pathname.startsWith(`${RESIDENT_BROWSE_PATH}/`) ||
      pathname.startsWith("/rent/listings") ||
      pathname.startsWith("/resident") ||
      pathname.startsWith("/rent/apply"),
    [pathname],
  );
  const contactActive = useMemo(() => pathname === "/contact" || pathname === "/support", [pathname]);
  const docsActive = useMemo(
    () =>
      pathname.startsWith("/docs") ||
      pathname.startsWith("/why-proplane") ||
      // /pricing is deliberately still highlighted here even though it is no
      // longer a Resources dropdown entry — the page stays live and is linked
      // from elsewhere, so the tab should light up when a visitor lands on it.
      pathname.startsWith("/pricing") ||
      pathname.startsWith("/about"),
    [pathname],
  );
  const productActive = useMemo(
    () =>
      residentActive ||
      pathname.startsWith("/partner") ||
      pathname.startsWith("/vendors") ||
      pathname === "/",
    [pathname, residentActive],
  );

  const menu: NavbarMenuItem[] = useMemo(
    () => {
      // Product · Resources · Contact — Product is role entry only (manager /
      // resident / vendor), each with a short description.
      const items: NavbarMenuItem[] = [
        {
          title: "Product",
          url: "/#product",
          active: productActive && !docsActive && !contactActive,
          dataAttr: "nav-product",
          items: [
            {
              title: "For managers",
              url: "/partner",
              description: "AI leasing, rent, vendors, and approvals",
              active: pathname.startsWith("/partner"),
              dataAttr: "nav-product-managers",
            },
            {
              title: "For residents",
              url: RESIDENT_BROWSE_PATH,
              description: "Browse homes, apply, pay rent, and message",
              active: residentActive,
              dataAttr: "nav-product-residents",
            },
            {
              title: "For vendors",
              url: "/vendors",
              description: "Jobs, bids, and payouts",
              active: pathname.startsWith("/vendors"),
              dataAttr: "nav-product-vendors",
            },
          ],
        },
        {
          title: "Resources",
          url: "/why-proplane",
          active: docsActive,
          dataAttr: "nav-resources",
          items: [
            {
              title: "Why PropLane",
              url: "/why-proplane",
              description: "AI, portals, and books · what makes it different",
              active: pathname.startsWith("/why-proplane"),
              dataAttr: "nav-resources-why",
            },
            {
              title: "Documentation",
              url: "/docs",
              description: "Guides for managers, residents, and vendors",
              active: pathname.startsWith("/docs"),
              dataAttr: "nav-resources-docs",
            },
            {
              title: "MCP & API",
              url: "/docs/mcp",
              description: "Connect your own AI agent to PropLane",
              active: pathname.startsWith("/docs/mcp"),
              dataAttr: "nav-resources-mcp",
            },
            {
              title: "About us",
              url: "/about",
              description: "Built by managers who use PropLane daily",
              active: pathname.startsWith("/about"),
              dataAttr: "nav-resources-about",
            },
          ],
        },
        {
          title: "Contact",
          url: "/contact",
          active: contactActive,
          dataAttr: "nav-contact",
        },
      ];
      return items;
    },
    [contactActive, docsActive, pathname, productActive, residentActive],
  );

  const portalLink = useMemo(() => {
    if (!signedIn || !primaryRole) return undefined;
    const url = portalDashboardPath(primaryRole);
    return {
      text: portalLinkLabel(),
      url,
    };
  }, [signedIn, primaryRole]);

  if (hideOnNative) return null;

  return (
    <div
      id="axis-public-navbar"
      className="sticky top-0 z-50 border-b border-border bg-background pt-[env(safe-area-inset-top,0px)]"
    >
      <Navbar1
        logoSlot={<AxisLogoLink href="/" size="compact" />}
        menu={menu}
        auth={{
          login: { text: "Log in", url: "/auth/sign-in" },
          signup: { text: "Get started", url: "/auth/create-account?mode=create&role=manager" },
        }}
        portalLink={portalLink}
      />
    </div>
  );
}
