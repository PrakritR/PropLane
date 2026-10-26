/**
 * Stubs for the vendor-ready browser proof. Only the portal session, the app-UI
 * provider (toasts / confirm), Next navigation and `next/link`, and analytics are
 * replaced. The REAL `VendorWorkOrdersPanel`, `VendorTaskList`,
 * `VendorCommunication` / `VendorInboxPanel`, `ManagerOutgoingInvoicesPanel`,
 * `VendorInvoiceManagerPaySheet`, `ManagerWorkOrdersPanel`, their shared portal
 * kit and the project's own Tailwind build all render. Data arrives through
 * intercepted `/api/**`.
 */
import React from "react";

type Session = { userId: string | null; email: string | null; ready: boolean };
const FALLBACK_SESSION: Session = { userId: "usr-harbor", email: "dispatch@harborplumbing.com", ready: true };
function session(): Session {
  const w = window as unknown as { __session?: Session };
  return w.__session ?? FALLBACK_SESSION;
}
export const usePortalSession = () => session();
export const useManagerUserId = () => session();
export const useNativePlatform = () => null;

/**
 * Toasts are what the vendor/manager actually reads back, so the spec asserts them.
 *
 * The returned object and its `showToast` are module-level CONSTANTS, not fresh
 * per render: panels put `showToast` in `useCallback` deps (`VendorTaskList`'s
 * `refresh` does), so a new identity each render re-runs the load effect forever
 * and the list never leaves "Loading…".
 */
const APP_UI = {
  showToast: (msg: string) => {
    const w = window as unknown as { __toasts: string[] };
    w.__toasts ??= [];
    w.__toasts.push(msg);
  },
};
export const useAppUi = () => APP_UI;
export const useOptionalAppUi = useAppUi;
const CONFIRM = () => Promise.resolve(true);
export const useConfirm = () => CONFIRM;
export function AppUiProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

const ROUTE_EVENT = "vendor-ready-fixture:route";
function routeFromLocation(fallback: string) {
  return new URLSearchParams(location.search).get("route") ?? fallback;
}
function go(href: string) {
  const w = window as unknown as { __navigations: string[] };
  w.__navigations ??= [];
  w.__navigations.push(href);
  const url = new URL(location.href);
  url.searchParams.set("route", href);
  history.pushState({}, "", url.toString());
  window.dispatchEvent(new Event(ROUTE_EVENT));
}
export function useFixtureRoute(fallback: string) {
  const [route, setRoute] = React.useState(() => routeFromLocation(fallback));
  React.useEffect(() => {
    const on = () => setRoute(routeFromLocation(fallback));
    window.addEventListener(ROUTE_EVENT, on);
    window.addEventListener("popstate", on);
    return () => {
      window.removeEventListener(ROUTE_EVENT, on);
      window.removeEventListener("popstate", on);
    };
  }, [fallback]);
  return route;
}
/** One constant router object, for the same reason `APP_UI` is one: identity goes into deps. */
const ROUTER = { push: go, replace: go, refresh: () => {}, prefetch: () => {}, back: () => history.back() };
export const useRouter = () => ROUTER;
export const usePathname = () => useFixtureRoute("/vendor/work-orders/assigned");
export const useSearchParams = () => new URLSearchParams(location.search);
export const useParams = () => ({});
export default function Link(
  props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean; scroll?: boolean },
) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { href, prefetch: _p, scroll: _s, children, onClick, ...rest } = props;
  return (
    <a
      href={href}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        e.preventDefault();
        go(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
