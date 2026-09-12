"use client";

import { AxisLogoLink } from "@/components/brand/axis-logo";
import { Navbar1, type NavbarMenuItem } from "@/components/ui/navbar1";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { portalDashboardPath, normalizePortalRoles, parseAuthRole, type AuthRole } from "@/lib/auth/portal-roles";
import {
  BOOK_DEMO_HREF,
  MANAGER_GET_STARTED_HREF,
  VENDOR_GET_STARTED_HREF,
} from "@/lib/marketing/public-contact";
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
  const pricingActive = useMemo(() => pathname.startsWith("/pricing"), [pathname]);
  const whyActive = useMemo(() => pathname.startsWith("/why-proplane"), [pathname]);
  const docsActive = useMemo(
    () =>
      pathname.startsWith("/docs") ||
      pathname.startsWith("/app") ||
      pathname.startsWith("/security") ||
      pathname.startsWith("/reviews") ||
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
      // Product ▾ · Pricing · Why PropLane · Resources ▾ · Contact.
      //
      // Pricing is the second thing every buyer looks for, so it is a tab, not
      // a dropdown entry; Product is the audience switch; Resources carries the
      // reading. Routes are unchanged — /partner is "For managers", /rent is
      // "For residents" — only the words moved.
      const items: NavbarMenuItem[] = [
        {
          title: "Product",
          url: "/#product",
          active: productActive && !docsActive && !contactActive && !pricingActive && !whyActive,
          dataAttr: "nav-product",
          items: [
            {
              title: "For managers & landlords",
              url: "/partner",
              description: "List, screen, lease and collect — approval-first",
              active: pathname.startsWith("/partner"),
              dataAttr: "nav-product-managers",
            },
            {
              title: "For residents",
              url: RESIDENT_BROWSE_PATH,
              description: "Browse homes, apply, pay rent and ask",
              active: residentActive,
              dataAttr: "nav-product-residents",
            },
            {
              title: "For vendors",
              url: "/vendors",
              description: "Get matched, bid from your phone, get paid",
              active: pathname.startsWith("/vendors"),
              dataAttr: "nav-product-vendors",
            },
          ],
        },
        {
          title: "Pricing",
          url: "/pricing",
          active: pricingActive,
          dataAttr: "nav-pricing",
        },
        {
          title: "Why PropLane",
          url: "/why-proplane",
          active: whyActive,
          dataAttr: "nav-why",
        },
        {
          title: "Resources",
          url: "/docs",
          active: docsActive,
          dataAttr: "nav-resources",
          items: [
            {
              title: "Documentation",
              url: "/docs",
              description: "Guides for managers, residents, and vendors",
              active: pathname.startsWith("/docs") && !pathname.startsWith("/docs/mcp"),
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
              title: "Mobile app",
              url: "/app",
              description: "The same queue on iPhone, with push and camera",
              active: pathname.startsWith("/app"),
              dataAttr: "nav-resources-app",
            },
            {
              title: "Security",
              url: "/security",
              description: "How your data and your residents' data are kept",
              active: pathname.startsWith("/security"),
              dataAttr: "nav-resources-security",
            },
            {
              title: "Reviews",
              url: "/reviews",
              description: "What managers and residents say",
              active: pathname.startsWith("/reviews"),
              dataAttr: "nav-resources-reviews",
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
    [contactActive, docsActive, pathname, pricingActive, productActive, residentActive, whyActive],
  );

  const portalLink = useMemo(() => {
    if (!signedIn || !primaryRole) return undefined;
    const url = portalDashboardPath(primaryRole);
    return {
      text: portalLinkLabel(),
      url,
    };
  }, [signedIn, primaryRole]);

  // The header CTA is the most prominent button on the page, and it pointed at
  // MANAGER signup everywhere — including /rent, where the visitor is a renter
  // looking for a home. Route the renter surfaces to resident signup instead.
  // PRP-307: the fallback used to hard-code role=manager, so the most prominent
  // button on the public site decided the visitor's role FOR them. A renter or
  // vendor arriving from the landing page was silently put into manager signup
  // and only found out once they were inside the wrong portal. Role-less lands
  // on CreateAccountRoleGateway, which asks. /rent keeps its answer because a
  // visitor browsing homes has already told us what they are.
  const signupHref = useMemo(() => {
    const path = pathname ?? "";
    if (path.startsWith("/rent")) {
      return "/auth/create-account?mode=create&role=resident";
    }
    if (path.startsWith("/partner")) {
      return MANAGER_GET_STARTED_HREF;
    }
    if (path.startsWith("/vendors")) {
      return VENDOR_GET_STARTED_HREF;
    }
    return "/auth/create-account";
  }, [pathname]);

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
          // "Start free" says what the button does — it is a $0 plan, not a form.
          signup: { text: "Start free", url: signupHref },
          secondary: { text: "Book a demo", url: BOOK_DEMO_HREF, dataAttr: "nav-book-demo" },
        }}
        portalLink={portalLink}
      />
    </div>
  );
}
