/** Only what is neither the pager nor an editor: analytics, routing, the assistant rail and PDF bytes. */
export const ModalAssistantStrip = () => null;
export const UploadedLeasePdfPreview = () => null;
export const useRouter = () => ({ replace: () => {}, push: () => {}, back: () => {}, refresh: () => {}, prefetch: () => {} });
export const useSearchParams = () => new URLSearchParams();
export const usePathname = () => "/portal/properties/p1";
const analytics = { capture: () => {}, captureException: () => {}, init: () => {} };
export default analytics;
