import "server-only";
import { claimWaitingDirectoryBalances } from "@/lib/managed-finance/directory-vendor.server";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { ensureFreeManagerPortalAccess } from "@/lib/auth/manager-portal-provision";
import { readPhoneIdentity } from "@/lib/auth/phone-auth.server";
import { provisionVendorAccountByEmail } from "@/lib/auth/provision-vendor-account";
import { createDraftFromHints } from "@/lib/one-number/onboarding/house-draft.server";
import { markSetupLinkUsed, markSetupLinkWaitlisted, type SetupLink } from "@/lib/one-number/onboarding/setup-links.server";
import { decideWaitlist } from "@/lib/one-number/onboarding/waitlist.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";

/**
 * Finish setup, after the person proved the phone by SMS code (`/api/auth/phone/verify` set the
 * session). The signed-in account must hold a VERIFIED phone, and for a phone-bound link it must be
 * the very number the link was texted to: a forwarded link signs in as someone else and finishes
 * nothing. Then the account is created (manager or vendor), a landlord's first house becomes a DRAFT,
 * and the link is spent. It never redirects into a portal: the page offers an explicit button
 * (docs/agents/manager-account-creation.md).
 */
export type FinishSetupResult =
  | { ok: true; kind: SetupLink["kind"]; portalHref: string; draftPropertyId: string | null; already: boolean }
  | { ok: false; reason: "phone_unverified" | "phone_mismatch" | "waitlisted" | "unavailable" };

export const MANAGER_SETUP_PORTAL_HREF = "/portal/dashboard";
export const VENDOR_SETUP_PORTAL_HREF = "/vendor/onboarding";

export async function finishSetup(
  db: SupabaseClient,
  input: { link: SetupLink; user: User },
  deps: { now?: () => Date; env?: NodeJS.ProcessEnv } = {},
): Promise<FinishSetupResult> {
  const { link, user } = input;
  const now = (deps.now ?? (() => new Date()))();
  const portalHref = link.kind === "vendor" ? VENDOR_SETUP_PORTAL_HREF : MANAGER_SETUP_PORTAL_HREF;

  let identity: { phone: string | null; verified: boolean };
  try {
    identity = await readPhoneIdentity(db, user.id);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (!identity.verified || !identity.phone) return { ok: false, reason: "phone_unverified" };
  if (link.phoneKey && normalizeConsentPhone(identity.phone) !== link.phoneKey) return { ok: false, reason: "phone_mismatch" };

  // Spent by this same account: report done, create nothing twice.
  if (link.usedAt) {
    return link.userId === user.id
      ? { ok: true, kind: link.kind, portalHref, draftPropertyId: null, already: true }
      : { ok: false, reason: "unavailable" };
  }

  try {
    if (link.kind === "landlord") {
      // Someone who already runs a workspace is not a new landlord and never waits.
      const { data: managerRole } = await db.from("profile_roles").select("role").eq("user_id", user.id).eq("role", "manager").maybeSingle();
      const decision = managerRole ? { admit: true as const } : await decideWaitlist(db, link, deps.env);
      if (!decision.admit) {
        await markSetupLinkWaitlisted(db, link.id, user.id, now);
        return { ok: false, reason: "waitlisted" };
      }
      const access = await ensureFreeManagerPortalAccess(db, user, { trialForNewManager: true, allowResidentUpgrade: true });
      if (access.status !== "portal_ready") return { ok: false, reason: "unavailable" };
      const draft = await createDraftFromHints(db, { userId: user.id, linkId: link.id, hints: link.context });
      await markSetupLinkUsed(db, link.id, user.id, now);
      return { ok: true, kind: "landlord", portalHref, draftPropertyId: draft.propertyId, already: false };
    }

    const provisioned = await provisionVendorAccountByEmail(db, { userId: user.id, email: user.email ?? "", fullName: null, invite: null, confirmEmail: true });
    if (!provisioned.ok) return { ok: false, reason: "unavailable" };
    await claimWaitingDirectoryBalances(db, { userId: user.id, phone: identity.phone, phoneProven: true }).catch((error) => console.error("[vendor signup] phone balance claim failed", error instanceof Error ? error.name : "unknown"));
    if (link.context.vendorLeadId) {
      await db.from("sms_vendor_leads").update({ user_id: user.id, updated_at: now.toISOString() }).eq("id", link.context.vendorLeadId);
    }
    await markSetupLinkUsed(db, link.id, user.id, now);
    return { ok: true, kind: "vendor", portalHref, draftPropertyId: null, already: false };
  } catch (error) {
    console.error("finish setup failed", error instanceof Error ? error.name : "unknown");
    return { ok: false, reason: "unavailable" };
  }
}
