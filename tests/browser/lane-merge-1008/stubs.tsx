/**
 * Only session, navigation, analytics and the few storage hooks are replaced. Every
 * component, hook and piece of Tailwind under test is the real one.
 */

/* ---- session ---- */
export const usePortalSession = () => ({ userId: "mgr-1", email: "manager@example.com", ready: true });
export const useManagerUserId = () => ({ userId: "mgr-1", email: "manager@example.com", ready: true });

/* ---- navigation ---- */
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

/* ---- the service record's local stores and directories ---- */
export const useWorkAssignmentDirectory = () => ({ teamMembers: [], vendors: [] });
export const MANAGER_VENDORS_EVENT = "manager-vendors-changed";
export const readActiveManagerVendorRows = () => [];
export const syncManagerVendorsFromServer = () => Promise.resolve();
export const deleteManagerWorkOrderRow = () => true;
export const updateManagerWorkOrder = () => {};
export const syncManagerWorkOrdersFromServer = () => Promise.resolve();
