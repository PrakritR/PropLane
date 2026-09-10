import { LEASE, ROW, savedHtml, saveHtml } from "./fixture-data";
export const useAppUi = () => ({ showToast: () => {} });
export const resolveManagerLeaseGenerationRow = () => ROW;
export const leaseApplicationSnapshotForRow = () => ({});
export const leaseGenerationPreviewContextForRow = (
  _row: unknown,
  _user: unknown,
  templateId: string,
) => ({ templateId });
export const generateLeaseHtmlForRow = () => {
  saveHtml(LEASE);
  return { ok: true, version: 1 };
};
export const readLeasePipeline = () => [ROW];
export const getLeaseDocumentHtml = () => savedHtml;
export const saveLeaseDocumentHtml = (_id: string, html: string) => {
  saveHtml(html);
  return { ok: true };
};
export const buildAiGeneratedLeaseHtml = (ctx: { templateId?: string }) => ({
  kind: "generated",
  html:
    ctx.templateId === "short"
      ? LEASE.replace(
          "Residential lease regression fixture",
          "Short-term lease regression fixture",
        )
      : LEASE,
});
export const leaseContextFromApplication = () => ({});
export const buildLeasePacketEditAssistantContext = () => "";
export const cachedLandlordLegalName = () => "Example Manager";
export const LEASE_LANDLORD_PLACEHOLDER = "[LANDLORD ENTITY NAME]";
export const getPropertyById = () => ({ listingSubmission: { v: 1 } });
export const normalizeManagerListingSubmissionV1 = (value: unknown) => value;
export const listLeaseTemplateGenerateChoices = () => [
  { id: "long", label: "Long-term lease", template: { id: "long" } },
  { id: "short", label: "Short-term lease", template: { id: "short" } },
];
export const usePortalAssistantConfig = () => null;
export const ModalAssistantStrip = () => null;
export const UploadedLeasePdfPreview = () => null;
const analytics = { capture: () => {}, captureException: () => {} };
export default analytics;
