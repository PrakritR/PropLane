import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeVendorQuickReplies,
  starterVendorQuickReplies,
  type VendorQuickReply,
} from "@/lib/vendor-quick-replies";

/**
 * Quick replies live beside the vendor's notification settings, in the same
 * per-user JSON row (`notification_preferences`, service-role only, keyed on
 * the auth user id), under their own key. Saving here rewrites ONLY this key
 * and preserves every sibling (`vendor` notification topics, resident rows).
 */
const ROW_DATA_KEY = "vendorQuickReplies";

export async function loadVendorQuickReplies(
  db: SupabaseClient,
  userId: string,
): Promise<{ replies: VendorQuickReply[]; isStarterSet: boolean }> {
  const { data, error } = await db.from("notification_preferences").select("row_data").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  const blob = (data?.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY];
  const saved = normalizeVendorQuickReplies(blob);
  if (saved === null) return { replies: starterVendorQuickReplies(), isStarterSet: true };
  return { replies: saved, isStarterSet: false };
}

export async function saveVendorQuickReplies(
  db: SupabaseClient,
  userId: string,
  raw: unknown,
): Promise<VendorQuickReply[]> {
  const next = normalizeVendorQuickReplies(raw);
  if (next === null) throw new Error("Invalid quick replies.");
  const { data: existing, error: readError } = await db
    .from("notification_preferences")
    .select("row_data")
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  rowData[ROW_DATA_KEY] = next;
  const { error } = await db
    .from("notification_preferences")
    .upsert({ user_id: userId, row_data: rowData, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) throw new Error(error.message);
  return next;
}
