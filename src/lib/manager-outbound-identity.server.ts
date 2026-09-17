import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveWorkspaceWorkEmail } from "@/lib/manager-assistant-email/manager-assistant-email.server";

/**
 * The address a manager's own outbound mail should come FROM.
 *
 * Every portal email used to leave on one shared `RESEND_FROM`, so a resident, applicant or
 * teammate saw "PropLane" no matter which manager the message was actually about, and a reply
 * went to a synthetic address rather than to that manager. Once a workspace has a work email,
 * that is its identity on this platform and its mail should carry it.
 *
 * The address is the WORKSPACE's — one per workspace, exactly like the work number — and the
 * display name is the person who actually wrote, so a co-manager's message reads
 * `Bob Lee <assist-jane-smith@…>`: the recipient replies to the workspace, and the team can see
 * who said it. That is the email form of the number's "Sent by <teammate>".
 *
 * Returns `null` when the workspace has no active work email, and the caller keeps the shared
 * sender. Never throws: an unreachable mailbox record must not stop the message going out.
 */
export async function resolveManagerOutboundFrom(
  db: SupabaseClient,
  managerUserId: string | null | undefined,
): Promise<string | null> {
  const id = managerUserId?.trim();
  if (!id) return null;
  try {
    const workspace = await resolveWorkspaceWorkEmail(db, id);
    const address = workspace?.address?.trim();
    if (!address) return null;

    const { data } = await db.from("profiles").select("full_name").eq("id", id).maybeSingle();
    const name = String((data as { full_name?: string } | null)?.full_name ?? "").trim();
    // A display name containing a quote or angle bracket would break the header, so an
    // unusable name simply falls back to the bare address rather than being escaped into
    // something the recipient reads as gibberish.
    if (name && !/["<>\r\n]/.test(name)) return `${name} <${address}>`;
    return address;
  } catch {
    return null;
  }
}

/** Shared PropLane sender — auth mail and alerts *to* a manager, never manager-originated product mail. */
export function sharedPortalFromAddress(): string {
  return process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
}

/**
 * From header for a manager writing to a resident, vendor, or prospect.
 * Work email when the workspace has one; shared sender otherwise. SMS still
 * leaves on the workspace work number through `enqueueOwnerSms`.
 */
export async function managerOutboundFromHeader(
  db: SupabaseClient,
  managerUserId: string | null | undefined,
): Promise<string> {
  return (await resolveManagerOutboundFrom(db, managerUserId)) ?? sharedPortalFromAddress();
}

export function fromHeaderDisplayName(from: string): string {
  if (!from.includes("<")) return from.trim() || "PropLane";
  return from.slice(0, from.indexOf("<")).trim() || "PropLane";
}

export function fromHeaderAddress(from: string): string {
  return from.match(/<([^>]+)>/)?.[1]?.trim() || from.trim();
}
