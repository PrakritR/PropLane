/**
 * The only things replaced for the round-6 screenshots: routing, analytics, the modal assistant
 * strip, the work-assignment directory and the portal session. Every drawn component, its copy
 * and the current Tailwind CSS are the real ones; the inbox's own reads are answered as
 * intercepted API responses, not stubs.
 */
const ROUTER = { push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} };
const SEARCH_PARAMS = new URLSearchParams();
export const usePathname = () => "/portal/dashboard";
export const useRouter = () => ROUTER;
export const useSearchParams = () => SEARCH_PARAMS;
export const ModalAssistantStrip = () => null;
export const usePortalAssistantConfig = () => null;
export const track = () => {};
export const useWorkAssignmentDirectory = () => ({ teamMembers: [], vendors: [], ready: true });
const analytics = { capture: () => {}, captureException: () => {} };
export default analytics;

/** A signed-in manager, so the real inbox can mount without an auth round trip. */
const SESSION = { userId: "mgr-1", email: "manager@example.com", ready: true };
export const usePortalSession = () => SESSION;
export const useManagerUserId = () => SESSION;
