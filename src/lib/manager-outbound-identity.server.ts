import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadManagerAssistantEmail } from "@/lib/manager-assistant-email/manager-assistant-email.server";

/**
 * The address a manager's own outbound mail should come FROM.
 *
 * Every portal email used to leave on one shared `RESEND_FROM`, so a resident, applicant or
 * teammate saw "PropLane" no matter which manager the message was actually about, and a reply
 * went to a synthetic address rather than to that manager. Once a manager has a work email,
 * that is their identity on this platform and their mail should carry it.
 *
 * Returns `null` when the manager has no active work email, and the caller keeps the shared
 * sender. Never throws: an unreachable mailbox record must not stop the message going out.
 */
export async function resolveManagerOutboundFrom(
  db: SupabaseClient,
  managerUserId: string | null | undefined,
): Promise<string | null> {
  const id = managerUserId?.trim();
  if (!id) return null;
  try {
    const row = await loadManagerAssistantEmail(db, id);
    if (!row?.address) return null;

    const { data } = await db.from("profiles").select("full_name").eq("id", id).maybeSingle();
    const name = String((data as { full_name?: string } | null)?.full_name ?? "").trim();
    // A display name containing a quote or angle bracket would break the header, so an
    // unusable name simply falls back to the bare address rather than being escaped into
    // something the recipient reads as gibberish.
    if (name && !/["<>\r\n]/.test(name)) return `${name} <${row.address}>`;
    return row.address;
  } catch {
    return null;
  }
}
