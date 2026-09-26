"use client";

import { AxisLogoLink } from "@/components/brand/axis-logo";
import { AppStoreBadge } from "@/components/marketing/app-store-badge";
import {
  BookOpen,
  Building2,
  ClipboardList,
  CreditCard,
  KeyRound,
  LifeBuoy,
  MessageSquareText,
  Plug,
  ShieldCheck,
  Sparkles,
  Star,
  Users,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { Navbar1, type NavbarMenuItem } from "@/components/ui/navbar1";
import type { PublicSearchItem } from "@/components/layout/public-search-overlay";
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

/** The Product menu's featured panel: the iPhone app, with the badge. */
function NavFeaturedApp() {
  return (
    <div className="flex h-full flex-col gap-1.5 rounded-xl bg-primary/[0.06] p-4 text-[12.5px]">
      <p className="text-[10.5px] font-extrabold uppercase tracking-[0.12em] text-primary">iPhone app</p>
      <p className="text-[14px] font-bold text-foreground">The same queue, with push and camera.</p>
      <p className="text-muted">Free. Sign in with the same account.</p>
      <div className="mt-2">
        <AppStoreBadge dataAttr="nav-product-app-store" />
      </div>
      <Link href="/app" data-attr="nav-product-app" className="mt-1 text-[12.5px] font-bold text-primary hover:underline">
        About the app →
      </Link>
    </div>
  );
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
      pathname.startsWith("/app") ||
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
          intro: { title: "Explore Product", url: "/#product", dataAttr: "nav-product-intro" },
          groups: [
            {
              heading: "Portals",
              items: [
                {
                  title: "Managers & landlords",
                  url: "/partner",
                  description: "List, screen, lease and collect — the AI runs the busywork",
                  icon: <Building2 strokeWidth={2} aria-hidden />,
                  active: pathname.startsWith("/partner"),
                  dataAttr: "nav-product-managers",
                },
                {
                  title: "Residents",
                  url: RESIDENT_BROWSE_PATH,
                  description: "Browse homes, apply, pay rent, ask for help",
                  icon: <KeyRound strokeWidth={2} aria-hidden />,
                  active: residentActive,
                  dataAttr: "nav-product-residents",
                },
                {
                  title: "Vendors",
                  url: "/vendors",
                  description: "Get matched, bid from your phone, get paid",
                  icon: <Wrench strokeWidth={2} aria-hidden />,
                  active: pathname.startsWith("/vendors"),
                  dataAttr: "nav-product-vendors",
                },
              ],
            },
            {
              heading: "Features",
              items: [
                {
                  title: "Leasing",
                  url: "/partner#partner-rows-title",
                  description: "Listings, tours, applications, e-sign",
                  icon: <ClipboardList strokeWidth={2} aria-hidden />,
                  dataAttr: "nav-product-leasing",
                },
                {
                  title: "Payments",
                  url: "/partner#partner-rows-title",
                  description: "Charges, reminders, deposits, books",
                  icon: <CreditCard strokeWidth={2} aria-hidden />,
                  dataAttr: "nav-product-payments",
                },
                {
                  title: "Services",
                  url: "/partner#partner-rows-title",
                  description: "Requests, vendors, bids, maintenance",
                  icon: <Wrench strokeWidth={2} aria-hidden />,
                  dataAttr: "nav-product-services",
                },
                {
                  title: "Communication",
                  url: "/#product",
                  description: "Email, SMS, in-app — one thread",
                  icon: <MessageSquareText strokeWidth={2} aria-hidden />,
                  dataAttr: "nav-product-inbox",
                },
                {
                  title: "AI assistant",
                  url: "/why-proplane",
                  description: "Ask anything about your portfolio; it acts through the same tools you do",
                  icon: <Sparkles strokeWidth={2} aria-hidden />,
                  dataAttr: "nav-product-assistant",
                },
              ],
            },
          ],
          featured: <NavFeaturedApp />,
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
          groups: [
            {
              heading: "Learn",
              items: [
                {
                  title: "Documentation",
                  url: "/docs",
                  description: "Guides for managers, residents, and vendors",
                  icon: <BookOpen strokeWidth={2} aria-hidden />,
                  active: pathname.startsWith("/docs") && !pathname.startsWith("/docs/mcp"),
                  dataAttr: "nav-resources-docs",
                },
                {
                  title: "MCP & API",
                  url: "/docs/mcp",
                  description: "Connect your own AI agent to PropLane",
                  icon: <Plug strokeWidth={2} aria-hidden />,
                  active: pathname.startsWith("/docs/mcp"),
                  dataAttr: "nav-resources-mcp",
                },
                {
                  title: "Security",
                  url: "/security",
                  description: "How your data and your residents' data are kept",
                  icon: <ShieldCheck strokeWidth={2} aria-hidden />,
                  active: pathname.startsWith("/security"),
                  dataAttr: "nav-resources-security",
                },
              ],
            },
            {
              heading: "Company",
              items: [
                {
                  title: "Reviews",
                  url: "/reviews",
                  description: "What managers and residents say",
                  icon: <Star strokeWidth={2} aria-hidden />,
                  active: pathname.startsWith("/reviews"),
                  dataAttr: "nav-resources-reviews",
                },
                {
                  title: "About us",
                  url: "/about",
                  description: "Built by managers who use PropLane daily",
                  icon: <Users strokeWidth={2} aria-hidden />,
                  active: pathname.startsWith("/about"),
                  dataAttr: "nav-resources-about",
                },
                {
                  title: "Contact & support",
                  url: "/contact",
                  description: "Talk to a person — email or phone",
                  icon: <LifeBuoy strokeWidth={2} aria-hidden />,
                  active: contactActive,
                  dataAttr: "nav-resources-contact",
                },
              ],
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

  // Real routes only, for the search overlay — flattened straight from the
  // same `menu` data plus a handful of top-level pages that aren't in a
  // dropdown (home, sign in, the app). Never a fabricated destination — see
  // the Log-in note below for the one destination this deliberately does
  // NOT split by role.
  const searchItems: PublicSearchItem[] = useMemo(() => {
    const items: PublicSearchItem[] = [{ title: "Home", url: "/", group: "PropLane" }];
    for (const top of menu) {
      if (!top.groups) {
        items.push({ title: top.title, url: top.url, group: "PropLane" });
        continue;
      }
      if (top.intro) items.push({ title: top.intro.title, url: top.intro.url, group: top.title });
      for (const g of top.groups) {
        for (const sub of g.items) items.push({ title: sub.title, url: sub.url, group: top.title });
      }
    }
    items.push(
      { title: "The iPhone app", url: "/app", group: "PropLane" },
      { title: "Sign in", url: "/auth/sign-in", group: "Account" },
      { title: "Start free", url: signupHref, group: "Account" },
    );
    return items;
  }, [menu, signupHref]);

  if (hideOnNative) return null;

  return (
    <div
      id="axis-public-navbar"
      className="sticky top-0 z-50 border-b border-border bg-background pt-[env(safe-area-inset-top,0px)]"
    >
      <Navbar1
        logoSlot={<AxisLogoLink href="/" size="compact" showWordmark={false} />}
        menu={menu}
        auth={{
          // Deliberately ONE real link, not a "Manager / Resident / Vendor"
          // dropdown: /auth/sign-in has no per-role variant or query-param
          // hint (checked `src/app/auth/sign-in/page.tsx`) — every account
          // signs in at the same place and is routed by its own role after
          // auth, so a role-split Log-in menu would point three items at an
          // identical destination. Real routes only, never an invented one.
          login: { text: "Log in", url: "/auth/sign-in" },
          // "Start free" says what the button does — it is a $0 plan, not a
          // form; the button itself renders the trailing "↗".
          signup: { text: "Start free", url: signupHref },
          secondary: { text: "Book a demo", url: BOOK_DEMO_HREF, dataAttr: "nav-book-demo" },
        }}
        portalLink={portalLink}
        mobileFooter={<AppStoreBadge dataAttr="nav-mobile-app-store" />}
        searchItems={searchItems}
      />
    </div>
  );
}
