"use client";

const STORAGE_PREFIX = "axis_manager_sms_opened_v2";

/** Fired whenever `markManagerSmsOpenedIds` records a newly-opened message, so the sidebar badge can recount without waiting on its next poll. */
export const MANAGER_SMS_OPENED_CHANGED_EVENT = "axis:manager-sms-opened-changed";

function storageKey(viewerId: string | null | undefined): string | null {
  const id = viewerId?.trim();
  return id ? `${STORAGE_PREFIX}:${id}` : null;
}

function readStoredOpenedIds(key: string): Set<string> {
  const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]") as unknown;
  if (!Array.isArray(parsed)) throw new Error("Opened SMS state is malformed.");
  return new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0));
}

export function loadManagerSmsOpenedIds(
  viewerId: string | null | undefined,
  fallback?: ReadonlySet<string>,
): Set<string> {
  return loadManagerSmsOpenedIdsWithFallback(viewerId, fallback);
}

/**
 * A storage read error must not erase receipts already confirmed in this tab.
 * The fallback is deliberately memory-only - callers still receive the error
 * on a write and must surface recoverable persistence failure.
 */
export function loadManagerSmsOpenedIdsWithFallback(
  viewerId: string | null | undefined,
  fallback?: ReadonlySet<string>,
): Set<string> {
  const key = storageKey(viewerId);
  if (!key || typeof window === "undefined") return new Set(fallback);
  try {
    return readStoredOpenedIds(key);
  } catch {
    return new Set(fallback);
  }
}

export function markManagerSmsOpenedIds(
  viewerId: string | null | undefined,
  messageIds: string[],
  fallback?: ReadonlySet<string>,
): Set<string> {
  const key = storageKey(viewerId);
  if (!key || typeof window === "undefined") return new Set(fallback);
  // Do not let a memory-only receipt masquerade as durable membership. A
  // close/reopen after setItem recovers must persist the explicitly reopened
  // ids even though the fallback already renders them as opened.
  const stored = readStoredOpenedIds(key);
  const current = new Set([...stored, ...(fallback ?? [])]);
  const durableNext = new Set(stored);
  for (const id of messageIds) {
    const clean = id.trim();
    if (clean) {
      current.add(clean);
      durableNext.add(clean);
    }
  }
  const durableChanged = durableNext.size !== stored.size || [...durableNext].some((id) => !stored.has(id));
  if (durableChanged) window.localStorage.setItem(key, JSON.stringify([...durableNext]));
  if (messageIds.some((id) => id.trim())) {
    window.dispatchEvent(new CustomEvent(MANAGER_SMS_OPENED_CHANGED_EVENT));
  }
  return current;
}
