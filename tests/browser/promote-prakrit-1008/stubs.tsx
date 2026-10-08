/**
 * Only session, navigation, analytics and the Supabase client are replaced. Every
 * component, hook and piece of Tailwind under test is the real one.
 */

/* ---- session ---- */
export const usePortalSession = () => ({ userId: "mgr-1", email: "manager@example.com", ready: true });
export const useManagerUserId = () => ({ userId: "mgr-1", email: "manager@example.com", ready: true });

/* ---- navigation ---- */
export const usePortalNavigate = () => (href: string) => {
  (window as unknown as { __navigated?: string[] }).__navigated ??= [];
  (window as unknown as { __navigated: string[] }).__navigated.push(href);
};
export const useRouter = () => ({
  push: (href: string) => {
    (window as unknown as { __navigated?: string[] }).__navigated ??= [];
    (window as unknown as { __navigated: string[] }).__navigated.push(href);
  },
  replace: () => {},
  refresh: () => {},
  prefetch: () => {},
  back: () => {},
});
export const usePathname = () => new URLSearchParams(location.search).get("pathname") ?? "/portal/dashboard";
export const useSearchParams = () => new URLSearchParams();
export const useParams = () => ({});
export const redirect = () => {};
export const notFound = () => {};

/* ---- analytics ---- */
export const track = () => {};
export const trackEvent = () => {};
export const isDemoModeActive = () => false;
const analytics = {
  capture: () => {},
  captureException: () => {},
  init: () => {},
  has_opted_out_capturing: () => false,
  opt_out_capturing: () => {},
  opt_in_capturing: () => {},
  stopSessionRecording: () => {},
};
export default analytics;
