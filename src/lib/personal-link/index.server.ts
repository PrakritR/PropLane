import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mintPhoneBoundLink, PhoneBoundLinkError } from "@/lib/one-number/links.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { personalLinkTargetId, PERSONAL_LINK_TARGET_TYPE } from "./model";

/**
 * Personal account link (design-1112 §3.0 / §5). `https://<canonical origin>/l/<token>`, purpose `account`, bound to
 * ONE phone and one workspace (+ the home the person asked about). Returns null when the phone is not a deliverable
 * number, the workspace cannot issue links (a private test namespace, a missing row), the per-phone mint cap is hit,
 * or the table is unavailable: the callers treat a link as a courtesy and never fail the message on it.
 *
 * A newer link for the same phone + workspace + home replaces the older one (the older then reads as expired), so
 * "send it again" leaves exactly one live link.
 */
export async function mintPersonalAccountLink(
  db: SupabaseClient,
  input: { phoneE164: string; workspaceId: string; propertyId?: string | null; createdBy?: string | null },
): Promise<string | null> {
  const phone = normalizeE164(input.phoneE164);
  if (!phone || !input.workspaceId?.trim()) return null;
  try {
    const minted = await mintPhoneBoundLink(db, {
      phoneKey: phone,
      workspaceId: input.workspaceId,
      purpose: "account",
      targetType: PERSONAL_LINK_TARGET_TYPE,
      targetId: personalLinkTargetId(input.workspaceId, input.propertyId),
      createdBy: input.createdBy ?? null,
    });
    return minted.url;
  } catch (error) {
    if (error instanceof PhoneBoundLinkError) return null;
    // Never log the phone or the token: the error class is enough to find it.
    console.error("[personal-link] mint failed", error instanceof Error ? error.name : "unknown");
    return null;
  }
}
