"use client";

import { useCallback, useEffect, useState } from "react";
import { invalidateSharedGets, sharedGet } from "@/lib/shared-get-cache";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  normalizeVendorQuickReplies,
  starterVendorQuickReplies,
  type VendorQuickReply,
} from "@/lib/vendor-quick-replies";

export const VENDOR_QUICK_REPLIES_URL = "/api/vendor/quick-replies";
/** Fired after a save so every mounted picker re-reads the list. */
export const VENDOR_QUICK_REPLIES_CHANGED_EVENT = "proplane:vendor-quick-replies-changed";

/**
 * The signed-in vendor's own quick replies (starter set until they save their
 * own). `/demo` never writes real rows: it serves the starters and keeps edits
 * in memory only.
 */
export function useVendorQuickReplies() {
  const demo = isDemoModeActive();
  const [replies, setReplies] = useState<VendorQuickReply[]>(() => (demo ? starterVendorQuickReplies() : []));
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (demo) return;
    const read = await sharedGet(VENDOR_QUICK_REPLIES_URL);
    const body = read.ok ? (read.data as { replies?: unknown } | null) : null;
    const list = normalizeVendorQuickReplies(body?.replies);
    if (!read.ok || list === null) {
      setError("Could not load quick replies.");
      setLoading(false);
      return;
    }
    setError(null);
    setReplies(list);
    setLoading(false);
  }, [demo]);

  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener(VENDOR_QUICK_REPLIES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(VENDOR_QUICK_REPLIES_CHANGED_EVENT, onChanged);
  }, [load]);

  /** Replace the whole list. Resolves `{ ok: false }` (list unchanged) when the save fails. */
  const save = useCallback(
    async (next: VendorQuickReply[]): Promise<{ ok: boolean; error?: string }> => {
      if (demo) {
        setReplies(next);
        return { ok: true };
      }
      try {
        const res = await fetch(VENDOR_QUICK_REPLIES_URL, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ replies: next }),
        });
        const body = (await res.json().catch(() => ({}))) as { replies?: unknown; error?: string };
        const saved = normalizeVendorQuickReplies(body.replies);
        if (!res.ok || saved === null) return { ok: false, error: body.error ?? "Could not save quick replies." };
        setReplies(saved);
        invalidateSharedGets(VENDOR_QUICK_REPLIES_URL);
        window.dispatchEvent(new Event(VENDOR_QUICK_REPLIES_CHANGED_EVENT));
        return { ok: true };
      } catch {
        return { ok: false, error: "No connection. Your change is still here." };
      }
    },
    [demo],
  );

  return { replies, loading, error, save, reload: load };
}
