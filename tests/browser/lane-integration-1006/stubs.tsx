/**
 * Only data, analytics and network are replaced. Every component, hook and piece of
 * Tailwind under test is the real one.
 */
import { FORMS } from "./fixture-data";

/* ---- move-in forms client (the server's answer) ---- */
export const MOVE_IN_FORMS_CHANGED = "move-in-forms-changed";
export const loadMoveInForms = async (
  _userId: string,
  _role: string,
  query: { applicationId?: string } = {},
) => ({
  forms: query.applicationId ? FORMS.filter((f) => f.applicationId === query.applicationId) : FORMS,
  unread: 1,
});
export const getMyMoveInForm = async () => null;
export const saveMyMoveInFormDraft = async () => ({});
export const submitMyMoveInForm = async () => ({});
export const uploadMyMoveInFormFile = async () => ({});
export const sendMoveInFormToCurrentResidents = async () => ({});
export const uploadMoveInFormPdf = async () => ({});
export const downloadMoveInFormPdf = async () => ({});
export const remindMoveInForm = async () => ({});
export const cancelMoveInForm = async () => ({});
export const editMoveInForm = async () => ({});
export const markMoveInFormViewed = async () => ({});
export const invalidateMoveInForms = () => {};

/* ---- portfolio / property options ---- */
export const buildManagerPropertyFilterOptions = () => [
  { id: "prop-1", label: "Alder Row" },
  { id: "prop-2", label: "Birch Court" },
];
export const resolveManagerScopeUserId = (id: string | null) => id;
export const activeWorkspacePropertyOptions = () => [];
export const workspaceContainsProperty = () => true;

/* ---- session / nav / analytics ---- */
export const usePortalSession = () => ({ userId: "mgr-1", email: "manager@example.com", ready: true });
export const usePortalNavigate = () => () => {};
export const track = () => {};
export const trackEvent = () => {};
export const isDemoModeActive = () => false;
export const useRouter = () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} });
export const usePathname = () => "/portal/forms";
export const useSearchParams = () => new URLSearchParams();
const analytics = { capture: () => {}, captureException: () => {}, init: () => {} };
export default analytics;

export const sendMoveInForm = async () => ({});
export const getMoveInForm = async () => null;
export const moveInFormUrl = (id: string) => `/portal/forms/${id}`;
export const moveInFormFileUrl = (id: string) => `/api/move-in-forms/${id}/file`;

export const deleteMyMoveInFormFile = async () => ({});
export const moveInFormTemplatePdfUrl = (id: string) => `/api/move-in-forms/templates/${id}/pdf`;
