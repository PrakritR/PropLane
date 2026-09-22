"use client";

/**
 * Conversation ids the manager permanently hid from the Communication list
 * (distinct from archive, which is reversible). Lifted out of
 * `pro-unified-inbox.tsx` into its own client lib — like
 * `manager-sms-archive.client.ts` and `manager-sms-opened.client.ts` — so the
 * sidebar badge (`use-portal-nav-counts.ts`) can read the exact same ids
 * without importing the whole Communication list component.
 */
export const SMS_HIDDEN_STORAGE_KEY = "axis_manager_sms_hidden_v2";

export function loadSmsHiddenIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(SMS_HIDDEN_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0));
  } catch {
    return new Set();
  }
}
