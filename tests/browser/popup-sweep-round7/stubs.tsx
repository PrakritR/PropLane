/**
 * The only things replaced for the round-7 pop-up sweep screenshots: data providers, routing,
 * analytics and the assistant strip. Every pop-up, its shell, its labels and the current Tailwind
 * CSS are the real ones.
 */
import type { ReactNode } from "react";

const APP_UI = { showToast: () => {} };
const DIRECTORY = { teamMembers: [], vendors: [], ready: true };
const RESIDENCIES = {
  residencies: [
    {
      id: "a1",
      name: "Ada Lovelace",
      property: "Brooklyn House",
      room: "Room 1",
      canCreate: true,
      propertyId: "p1",
      moveInDate: "2026-09-01",
      moveOutDate: "",
      occupancy: "current" as const,
    },
  ],
};

export const useAppUi = () => APP_UI;
const CONFIRM = () => Promise.resolve(true);
const ROUTER = { push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} };
const SEARCH_PARAMS = new URLSearchParams();
const PROPERTY_OPTIONS = [{ propertyId: "p1", propertyLabel: "Brooklyn House" }];

export const useConfirm = () => CONFIRM;
export const usePathname = () => "/portal/tasks";
export const useRouter = () => ROUTER;
export const useSearchParams = () => SEARCH_PARAMS;
export const useWorkAssignmentDirectory = () => DIRECTORY;
export const fetchManagerTimeSuggestion = () => Promise.resolve(null);
export const ModalAssistantStrip = (_props: { children?: ReactNode }) => null;
export const usePortalAssistantConfig = () => null;
export const track = () => {};
export const loadInspectionList = () => Promise.resolve(RESIDENCIES);
export const sendMoveInForm = () => Promise.resolve({ ok: true });
export const buildPropertyOptions = () => PROPERTY_OPTIONS;
export const buildResidentOptions = () => [];
export const residentMatchesProperty = () => true;
const analytics = { capture: () => {}, captureException: () => {} };
export default analytics;
