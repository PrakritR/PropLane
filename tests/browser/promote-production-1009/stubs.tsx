/**
 * Only session, navigation and analytics are replaced. Every component, hook
 * and piece of Tailwind under test is the real one, and every data read goes
 * over the network so the spec can shape it.
 */
export const usePortalSession = () => ({ userId: "mgr-1", email: "manager@example.com", ready: true });
export const useManagerUserId = () => ({ userId: "mgr-1", email: "manager@example.com", ready: true });

const remember = (href: string) => {
  (window as unknown as { __navigated?: string[] }).__navigated ??= [];
  (window as unknown as { __navigated: string[] }).__navigated.push(href);
};
export const usePortalNavigate = () => remember;
export const useRouter = () => ({
  push: remember,
  replace: () => {},
  refresh: () => {},
  prefetch: () => {},
  back: () => {},
});
export const usePathname = () => new URLSearchParams(location.search).get("pathname") ?? "/portal/dashboard";
export const useSearchParams = () => new URLSearchParams(location.search);
export const useParams = () => ({});
export const redirect = () => {};
export const notFound = () => {};

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
