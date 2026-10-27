import "server-only";

/**
 * The link a guest pays a confirmed stay with: a phone-bound `/l/<token>` (purpose `rent`, target the
 * stay's own `stay_total` charge) that opens the in-page payment form after a code is texted to that same
 * phone. No portal sign-in, no app, no other site. The destination re-derives the charge, its house's
 * workspace and the guest's phone from live rows (`rentDestination`), so this module only mints.
 *
 * Returns null when there is nothing to pay (no charge raised, already paid) or a link cannot be issued;
 * the caller then texts the plain confirmation, which still points at the guest's Application page.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveWorkspaceForProperty } from "@/lib/one-number/link-destinations.server";
import { mintPhoneBoundLink } from "@/lib/one-number/links.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { guestStayChargeId } from "@/lib/short-stay/stay-charge.server";

export async function mintStayPayLink(
  db: SupabaseClient,
  input: { blockId: string; ownerId: string; propertyId: string; phone: string },
): Promise<string | null> {
  const phoneKey = normalizeConsentPhone(input.phone);
  if (!/^\d{10}$/.test(phoneKey)) return null;
  const chargeId = guestStayChargeId(input.blockId);
  const { data } = await db.from("portal_household_charge_records").select("id, status").eq("id", chargeId).maybeSingle();
  const status = String((data as { status?: unknown } | null)?.status ?? "");
  if (!data || (status !== "pending" && status !== "failed")) return null;
  const workspaceId = await resolveWorkspaceForProperty(db, input.propertyId || null, input.ownerId);
  if (!workspaceId) return null;
  try {
    const minted = await mintPhoneBoundLink(db, {
      phoneKey,
      workspaceId,
      purpose: "rent",
      targetType: "charge",
      targetId: chargeId,
      createdBy: null,
    });
    return minted.url;
  } catch {
    return null;
  }
}
