import { clearPortalBrowserCache } from "@/lib/auth/clear-portal-browser-cache";

const STORAGE_KEY = "axis:dev-reset-epoch";

/**
 * Clear the browser's local mirror after a dev database wipe.
 *
 * The portal keeps a local mirror of listings, charges and prefs under `axis:*`.
 * After a dev reset the database is empty and the mirror is not, so the portal
 * shows properties that no longer exist — two tabs on the same account showed
 * "Listed 20" and "Listed 6" against a database with zero rows (PRP-195).
 *
 * That does not read as a stale cache. It reads as "deletion didn't work" or
 * "the portal is showing another account's data", and it silently invalidates
 * any QA run made after a reset, because a passing check may be passing on
 * cached rows.
 *
 * The wipe/seed scripts print a new `NEXT_PUBLIC_DEV_RESET_EPOCH`; the client
 * compares it on boot and clears the mirror when it changes.
 *
 * PRODUCTION IS EXCLUDED, deliberately and by construction: the value is unset
 * there, and an unset epoch does nothing at all. A bug here must never be able
 * to wipe a real user's local state.
 */
export function applyDevResetEpoch(
  epoch: string | undefined = process.env.NEXT_PUBLIC_DEV_RESET_EPOCH,
): { cleared: boolean; removed: number } {
  if (typeof window === "undefined") return { cleared: false, removed: 0 };
  const next = (epoch ?? "").trim();
  if (!next) return { cleared: false, removed: 0 };

  let previous: string | null = null;
  try {
    previous = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private window, site-data policy) — nothing to clear and
    // nothing to remember.
    return { cleared: false, removed: 0 };
  }

  if (previous === next) return { cleared: false, removed: 0 };

  // First run on a fresh browser has nothing to clear, but the epoch is still
  // recorded so the NEXT reset is detected.
  const removed = previous === null ? 0 : clearPortalBrowserCache();
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* best effort */
  }
  return { cleared: previous !== null, removed };
}

export const DEV_RESET_EPOCH_STORAGE_KEY = STORAGE_KEY;
