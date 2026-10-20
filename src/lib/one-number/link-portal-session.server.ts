import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { mintPhoneSession, phoneOwners } from "@/lib/auth/phone-auth.server";
import { residentPhoneMatches } from "@/lib/one-number/link-destinations.server";
import type { PhoneBoundLink } from "@/lib/one-number/links.server";
import { normalizeE164 } from "@/lib/phone-e164";

/**
 * A resident's lease or move-in link, after its one-time code, should land on the page and not ask for a
 * second sign-in. The code already proved the person holds the phone the link was bound to, which is the
 * proof phone sign-in asks for, so this opens the same kind of portal session `/api/auth/phone/verify`
 * does (`mintPhoneSession`: an admin-generated token hash verified on an isolated client).
 *
 * Narrow on purpose:
 * - only `lease` and `move_in` links to a resident (money and payouts links keep their own 30-minute
 *   session and a real sign-in);
 * - the link names the resident account, that account's verified profile phone must still be the link's
 *   phone, and that phone must belong to exactly that one account;
 * - an account with no email is left to the normal sign-in (minting would invent an address for it).
 * It works in every line mode: nothing here reads `line_mode`. Null on any doubt; the caller then keeps the
 * ordinary sign-in redirect.
 */
export async function mintResidentPortalSessionForLink(
  db: SupabaseClient,
  link: Pick<PhoneBoundLink, "purpose" | "targetType" | "targetId" | "phoneKey">,
): Promise<{ access_token: string; refresh_token: string } | null> {
  if (link.purpose !== "lease" && link.purpose !== "move_in") return null;
  if (link.targetType !== "resident" || !link.targetId) return null;
  try {
    if (!(await residentPhoneMatches(db, link.targetId, link.phoneKey))) return null;
    const phone = normalizeE164(link.phoneKey);
    if (!phone) return null;
    const owners = await phoneOwners(db, phone);
    if (owners.length !== 1 || owners[0] !== link.targetId) return null;
    const { data, error } = await db.auth.admin.getUserById(link.targetId);
    if (error || !data.user || !data.user.email || data.user.email.endsWith("@phone.proplane.invalid")) return null;
    return await mintPhoneSession(db, data.user);
  } catch {
    return null;
  }
}
