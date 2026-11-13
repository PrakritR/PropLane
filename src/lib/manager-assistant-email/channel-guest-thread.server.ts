import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelSite } from "@/lib/inbound-email/channel-senders";

/**
 * What a conversation with a booking-site guest is tagged with, stored on the thread row (`row_data.channelGuest`, free-form,
 * no migration) so Communication can mark it with the site and the house/room. Overwritten by the newest message: the relay
 * address is the freshest the site has given, and a guest who moves to another room is about that room now.
 */
export type ChannelGuestThreadTag = {
  site: ChannelSite;
  siteLabel: string;
  guestName: string;
  propertyId: string | null;
  propertyLabel: string | null;
  roomId: string | null;
  roomLabel: string | null;
  /** The site's relay address on the site's own domain, when the newest mail named one. */
  replyAddress: string | null;
  /** Newest guest message was held for the manager (money, cancellation, complaint, contact details, no relay). */
  held: boolean;
};

const ATTEMPTS = 4;

export async function stampChannelGuestOnThread(
  db: SupabaseClient,
  threadId: string,
  tag: ChannelGuestThreadTag,
): Promise<boolean> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const { data, error } = await db
      .from("portal_inbox_thread_records")
      .select("id, row_data, updated_at")
      .eq("id", threadId)
      .maybeSingle();
    if (error || !data) return false;
    const row = data as { row_data: Record<string, unknown> | null; updated_at: string | null };
    const next = { ...(row.row_data ?? {}), channelGuest: tag };
    const base = db.from("portal_inbox_thread_records").update({ row_data: next }).eq("id", threadId);
    const { data: written, error: writeError } = await (row.updated_at ? base.eq("updated_at", row.updated_at) : base.is("updated_at", null))
      .select("id")
      .maybeSingle();
    if (writeError) return false;
    if (written) return true;
  }
  return false;
}

/**
 * Merge a patch into a thread's `row_data` (free-form jsonb, no migration), compare-and-set on `updated_at` like the guest tag.
 * `platformState` is never downgraded: once a thread is `moved` to text, a late platform mail cannot flip it back to active.
 */
export async function stampThreadRowData(db: SupabaseClient, threadId: string, patch: Record<string, unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const { data, error } = await db
      .from("portal_inbox_thread_records")
      .select("id, row_data, updated_at")
      .eq("id", threadId)
      .maybeSingle();
    if (error || !data) return false;
    const row = data as { row_data: Record<string, unknown> | null; updated_at: string | null };
    const current = row.row_data ?? {};
    const next: Record<string, unknown> = { ...current, ...patch };
    const before = current.platformState as { state?: string } | undefined;
    if (before?.state === "moved" && patch.platformState) next.platformState = { ...(patch.platformState as object), ...before };
    const base = db.from("portal_inbox_thread_records").update({ row_data: next }).eq("id", threadId);
    const { data: written, error: writeError } = await (row.updated_at ? base.eq("updated_at", row.updated_at) : base.is("updated_at", null))
      .select("id")
      .maybeSingle();
    if (writeError) return false;
    if (written) return true;
  }
  return false;
}
