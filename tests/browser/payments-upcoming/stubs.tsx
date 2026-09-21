/**
 * Stubs for the payments-upcoming browser fixture (PLAN-0920-2357). Only the
 * session, app-UI provider, Next navigation/link, analytics and native
 * platform are replaced; the REAL `ManagerPayments`, `ResidentPaymentsPanel`,
 * `ProPortalSettingsModal`, `Modal`, filter sheet and Tailwind CSS render.
 * Data arrives through intercepted `/api/**` responses (see the spec).
 */
import React from "react";

type Session = { userId: string | null; email: string | null; ready: boolean };
function session(): Session {
  const w = window as unknown as { __session?: Session };
  return w.__session ?? { userId: "mgr-fixture", email: "manager@example.com", ready: true };
}
export const usePortalSession = () => session();
export const useManagerUserId = () => session();
export const useNativePlatform = () => null;

export const useAppUi = () => ({
  showToast: (msg: string) => {
    const w = window as unknown as { __toasts: string[] };
    w.__toasts ??= [];
    w.__toasts.push(msg);
  },
});
export const useConfirm = () => () => Promise.resolve(true);

/** Router stub: a push/replace becomes a full navigation to `?route=<href>` so the fixture re-mounts on the new route. */
function go(href: string) {
  const w = window as unknown as { __navigations: string[] };
  w.__navigations ??= [];
  w.__navigations.push(href);
  const url = new URL(location.href);
  url.searchParams.set("route", href);
  location.assign(url.toString());
}
export const useRouter = () => ({ push: go, replace: go, refresh: () => {}, prefetch: () => {}, back: () => history.back() });
export const usePathname = () => {
  const route = new URLSearchParams(location.search).get("route");
  return route ?? "/portal/payments/incoming/pending";
};
export const useSearchParams = () => new URLSearchParams();
export const useParams = () => ({});
/** `next/link` → plain anchor routed through the same stub. */
export default function Link(props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean; scroll?: boolean }) {
  // `prefetch` / `scroll` are Next-only: pulled out so they never reach the <a>.
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
export const useOptionalAppUi = useAppUi;
export function AppUiProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
