import { useCallback, useSyncExternalStore } from "react";

/**
 * Full-screen conversation (Communication, manager / resident / vendor).
 *
 * One boolean for the session: it survives a tab switch or remount inside the
 * page, never a new browser session, and it is cleared the moment the thread
 * closes. sessionStorage is a convenience only, so every access is guarded.
 */
export const INBOX_FULL_SCREEN_STORAGE_KEY = "proplane.inbox.fullScreen";

/** Tailwind `lg` — below it the thread is already a full page, so no button. */
export const INBOX_FULL_SCREEN_MIN_WIDTH_PX = 1024;

/** The icon button is a desktop affordance: hidden below `lg`. */
export const INBOX_FULL_SCREEN_BUTTON_CLASS = "hidden lg:inline-flex";

export function inboxFullScreenLabel(fullScreen: boolean): string {
  return fullScreen ? "Exit full screen" : "Full screen";
}

/** Full screen is only ever drawn on a wide viewport, with a thread open. */
export function inboxFullScreenActive(args: {
  fullScreen: boolean;
  threadOpen: boolean;
  viewportWidth: number;
}): boolean {
  return args.fullScreen && args.threadOpen && args.viewportWidth >= INBOX_FULL_SCREEN_MIN_WIDTH_PX;
}

function readStored(): boolean {
  try {
    return window.sessionStorage.getItem(INBOX_FULL_SCREEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let current: boolean | null = null;
const listeners = new Set<() => void>();

function snapshot(): boolean {
  if (current === null) current = readStored();
  return current;
}

export function setInboxFullScreen(next: boolean): void {
  if (snapshot() === next) return;
  current = next;
  try {
    if (next) window.sessionStorage.setItem(INBOX_FULL_SCREEN_STORAGE_KEY, "1");
    else window.sessionStorage.removeItem(INBOX_FULL_SCREEN_STORAGE_KEY);
  } catch {
    /* storage blocked: the in-memory value still holds for this page */
  }
  listeners.forEach((l) => l());
}

/** Test seam: forget the cached value so the next read hits storage again. */
export function resetInboxFullScreenForTests(): void {
  current = null;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInboxFullScreen(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(subscribe, snapshot, () => false);
  const set = useCallback((next: boolean) => setInboxFullScreen(next), []);
  return [value, set];
}
