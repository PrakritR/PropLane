import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadHome } from "@/lib/one-number/home-lock.server";

/**
 * Which home a locked phone is talking about, for the leasing SMS agent. Server-derived from `sms_line_sessions.locked_property_id`
 * (set only by a pick, a text naming one home, or a yes to the switch question) and re-checked against the database: the home
 * must be live and belong to the manager (and workspace) the text was routed to. It never comes from the text or the model, so
 * a switch moves it the moment the session's lock moves, and a lock that points at someone else's home reads as no lock.
 */
export type LockedHomeContext = { propertyId: string; label: string };

export async function loadLockedHomeContext(
  db: SupabaseClient,
  input: { prospectPhone: string; landlordId: string; workspaceId?: string | null },
): Promise<LockedHomeContext | null> {
  const phoneKey = input.prospectPhone.replace(/\D/g, "").slice(-10);
  if (phoneKey.length < 10 || !input.landlordId) return null;
  try {
    const { data, error } = await db.from("sms_line_sessions").select("locked_property_id").eq("phone_key", phoneKey).maybeSingle();
    if (error || !data) return null;
    const propertyId = String((data as { locked_property_id?: unknown }).locked_property_id ?? "").trim();
    if (!propertyId) return null;
    const home = await loadHome(db, propertyId, null);
    if (!home || home.ownerUserId !== input.landlordId) return null;
    if (input.workspaceId && home.workspaceId !== input.workspaceId.trim()) return null;
    return { propertyId: home.propertyId, label: home.label };
  } catch {
    return null;
  }
}

/** The line added to the leasing agent's system prompt for a locked phone. */
export function lockedHomePromptNote(home: LockedHomeContext): string {
  return `This prospect is locked to ${JSON.stringify(home.label)} (canonical property id ${JSON.stringify(home.propertyId)}), chosen earlier in this conversation. Questions like "is parking included?", "how much is it?" or "can I tour?" are about that home: call get_listing_details with that property id and answer from it. Only talk about a different home if the prospect clearly names one; the line then asks them to confirm before anything changes, so do not switch on your own.`;
}
