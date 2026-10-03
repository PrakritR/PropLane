export type ManagerCalendarViewMode = "day" | "week" | "month" | "agenda";

const STORAGE_PREFIX = "plp-cal0930-view:";

export function managerCalendarViewStorageKey(isPhone: boolean): string {
  return `${STORAGE_PREFIX}${isPhone ? "phone" : "desktop"}`;
}

export function defaultManagerCalendarViewMode(isPhone: boolean): ManagerCalendarViewMode {
  return isPhone ? "agenda" : "week";
}

const VALID: ManagerCalendarViewMode[] = ["day", "week", "month", "agenda"];

export function readManagerCalendarViewMode(isPhone: boolean): ManagerCalendarViewMode | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(managerCalendarViewStorageKey(isPhone));
    if (raw && VALID.includes(raw as ManagerCalendarViewMode)) return raw as ManagerCalendarViewMode;
  } catch {
    /* storage blocked */
  }
  return null;
}

export function writeManagerCalendarViewMode(isPhone: boolean, mode: ManagerCalendarViewMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(managerCalendarViewStorageKey(isPhone), mode);
  } catch {
    /* storage blocked */
  }
}
