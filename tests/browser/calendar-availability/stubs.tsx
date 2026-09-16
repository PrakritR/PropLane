/**
 * Stubs for the calendar-availability browser fixture. Only data providers,
 * the app-UI provider and Next navigation are replaced; the real
 * `PortalCalendarPanels`, Modal, Button, and Tailwind CSS render.
 */
import { writeAvailabilityDateSetForStorageKey } from "../../../src/lib/demo-admin-scheduling";
export * from "../../../src/lib/demo-admin-scheduling";
export const syncScheduleRecordsFromServer = async () => undefined;
export const readPlannedEvents = () => [];
/** In-memory "server": persists to the real in-page store and records every write. */
export const writeAvailabilityDateSetForStorageKeyToServer = async (set: Set<string>, storageKey: string) => {
  writeAvailabilityDateSetForStorageKey(set, storageKey);
  const w = window as unknown as { __written: { key: string; slots: string[] }[] };
  w.__written ??= [];
  w.__written.push({ key: storageKey, slots: [...set].sort() });
  return true;
};
export const useAppUi = () => ({
  showToast: (msg: string) => {
    (window as unknown as { __toasts: string[] }).__toasts ??= [];
    (window as unknown as { __toasts: string[] }).__toasts.push(msg);
  },
});
export const useConfirm = () => () => Promise.resolve(true);
export const usePathname = () => "/portal/calendar";
export const useSearchParams = () => new URLSearchParams();
export const useRouter = () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} });
export * from "../../../src/lib/rental-application/data";
export const getPropertyById = () => undefined;
/** `?booked` puts one confirmed tour on the fixture's Monday 11:00-11:30 (slot 22). */
export const buildScheduledTourMeetings = () => {
  if (!new URLSearchParams(location.search).has("booked")) return [];
  const fx = (window as unknown as { __fixture: { mondayDs: string } }).__fixture;
  const start = new Date(`${fx.mondayDs}T11:00:00`);
  const end = new Date(`${fx.mondayDs}T11:30:00`);
  return [
    {
      id: "planned-fixture-tour",
      source: "planned" as const,
      sourceId: "fixture-tour",
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      dateStr: fx.mondayDs,
      startSlot: 22,
      span: 1,
      durationMinutes: 30,
      title: "Tour · Sam Rivera",
      color: "#2563eb",
      statusLabel: "Confirmed",
      name: "Sam Rivera",
      kind: "tour" as const,
    },
  ];
};
export const useManagerUserId = () => ({ userId: "fixture-manager", email: "m@example.com", ready: true });
export const useWorkAssignmentDirectory = () => ({ teamMembers: [], vendors: [] });
const analytics = { capture: () => {}, captureException: () => {} };
export default analytics;
/** `node:crypto` shim for `src/lib/manager-id.ts` in the browser bundle. */
export const randomBytes = (n: number) => {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return { toString: () => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") };
};
