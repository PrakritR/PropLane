/** Target for skip-to-content links in authenticated portal layouts. */
export const PORTAL_MAIN_CONTENT_ID = "portal-main-content";

/** Scrollable main column inside the public `/demo` portal frame. */
export const DEMO_PORTAL_SCROLL_ID = "demo-portal-scroll";

/** Fit the available viewport in browsers and native shells, including mobile browser chrome. */
export const PORTAL_SHELL_ROOT_CLASS =
  "portal-shell flex h-dvh max-h-dvh max-w-full flex-col overflow-hidden bg-background [html[data-native]_&]:max-w-[100vw] [html[data-native]_&]:overflow-x-clip";

/** Mobile portal top chrome (section nav) — hidden in the native app (see portal-native-bottom-nav). */
export const PORTAL_MOBILE_CHROME_CLASS =
  "portal-mobile-chrome border-b border-border bg-background/92 backdrop-blur-xl lg:hidden [html[data-theme=light]_&]:bg-white/88";

/** Native app bottom tab bar — Instagram-style icon row, subtle top hairline in every mode. */
export const PORTAL_NATIVE_BOTTOM_NAV_CLASS =
  "portal-native-bottom-nav fixed inset-x-0 bottom-0 z-50 w-full max-w-full border-t border-border bg-background/94 shadow-[0_-10px_30px_rgba(15,23,42,0.08)] backdrop-blur-2xl lg:hidden pb-[max(0.375rem,env(safe-area-inset-bottom,0px))] [html[data-native]_&]:pb-0 [html[data-theme=light]_&]:bg-white/92";

/** One bottom-tab cell — fixed icon + label slots keep every tab on the same baseline. */
export const PORTAL_NATIVE_BOTTOM_NAV_ITEM_CLASS =
  "portal-native-bottom-nav-item portal-pressable relative flex min-h-[4rem] min-w-0 max-w-full flex-col items-center justify-end gap-1 px-1 pb-1.5 pt-1.5 transition active:scale-[.98] active:opacity-90";

export const PORTAL_NATIVE_BOTTOM_NAV_ICON_SLOT_CLASS =
  "relative flex h-[1.375rem] w-full shrink-0 items-center justify-center";

export const PORTAL_NATIVE_BOTTOM_NAV_LABEL_CLASS =
  "portal-native-bottom-nav-label block w-full max-w-full truncate text-center text-[9px] font-medium leading-none tracking-[-0.01em]";

export const PORTAL_NATIVE_BOTTOM_NAV_ICON_CLASS = "h-[1.375rem] w-[1.375rem] shrink-0";

/** Top-of-screen portal banners (upgrade strip, admin preview) — clears the notch. */
export const PORTAL_TOP_BANNER_STRIP_CLASS =
  "portal-top-banner-strip pt-[max(0.625rem,env(safe-area-inset-top,0px))] ps-[max(0px,env(safe-area-inset-left,0px))] pe-[max(0px,env(safe-area-inset-right,0px))] [html[data-native]_&]:pt-[max(0.75rem,var(--native-safe-top))] [html[data-native]_&]:ps-[max(0px,var(--native-safe-left))] [html[data-native]_&]:pe-[max(0px,var(--native-safe-right))]";

/**
 * @deprecated Native inset is set in globals.css via `--portal-native-bottom-nav-inset`
 * (measured from `.portal-native-bottom-nav` at runtime).
 */
export const PORTAL_NATIVE_BOTTOM_NAV_INSET = "var(--portal-native-bottom-nav-inset)";

/**
 * Scrollable main column: safe-area insets + tighter padding on small screens (all authenticated portals).
 * The light canvas is one flat soft gray (`--portal-canvas`) so white cards read as
 * surfaces; the old blue gradient + radial highlight fought every card edge.
 */
export const PORTAL_MAIN_CONTENT_CLASS =
  "relative z-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain px-3 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] ps-[max(0.75rem,env(safe-area-inset-left,0px))] pe-[max(0.75rem,env(safe-area-inset-right,0px))] sm:px-5 sm:pt-4 sm:pb-[max(1.5rem,env(safe-area-inset-bottom,0px))] lg:block lg:px-6 lg:pt-5 lg:pb-8 max-lg:pt-1 [html[data-native]_&]:overscroll-y-none [html[data-theme=dark]_&]:bg-[var(--portal-surface-dark)] [html[data-theme=light]_&]:bg-[var(--portal-canvas)]";

/** Mobile + native: content-sized height so #portal-main-content scrolls the full page. Desktop: normal flow. */
export const PORTAL_MAIN_CONTENT_INNER_CLASS =
  "portal-main-inner flex w-full flex-col justify-start max-lg:flex-none max-lg:min-h-min lg:flex-initial";
