/**
 * ResidentAgentContext resolved from a VERIFIED phone number instead of an
 * authenticated session, for the resident SMS agent.
 *
 * This is the single security choke point for resident data over SMS, and it is
 * deliberately stricter than `resolveResidentAgentContext`: that one starts from
 * a Supabase session, which proves the caller is who they say. Here the only
 * signal on the wire is the `From` header, which is attacker-influencable and
 * survives a phone number changing hands. Three independent facts must ALL hold
 * before any resident row is readable:
 *
 *   1. A profile's `phone` matches `From` exactly (normalized).
 *   2. That profile's `phone_verified_at` is set — the resident proved control
 *      of the number from inside the portal via the OTP flow. A manager typing
 *      a name onto a contact NEVER sets this; a manager-asserted link is a
 *      display label only.
 *   3. The manager who owns the work number that was texted is one of the
 *      managers linked to that resident. Without this a resident of manager A
 *      could read their own data by texting manager B's number, and every
 *      thread would land in the wrong tenant's inbox.
 *
 * Any one of these failing returns null, and the caller falls back to the
 * non-resident (leasing) agent, which holds no personal data.
 *
 * The returned shape is IDENTICAL to the portal's `ResidentAgentContext`, so
 * every resident tool's existing `ctx.userId` / `ctx.email` scoping applies
 * unchanged. That is the point: the safety of tools like
 * `cancel_scheduled_message` (which only ever sees rows where
 * `senderPortal = "resident"` AND `senderUserId = ctx.userId`, so a manager's
 * scheduled message is invisible and uncancellable) comes entirely from this
 * binding. Never populate `userId` from anything the inbound message carried.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { profilePhoneVariants } from "@/lib/sms-consent";
import { managerIdsOwningResident } from "@/lib/resident-manager-scope";
import { loadResidentPortalAccessState } from "@/lib/resident-portal-access";
import { getManagerSubscriptionTierByManagerId } from "@/lib/manager-access-server";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";

export type ResidentSmsIdentityFailure =
  | "invalid_phone"
  | "no_verified_profile"
  | "not_a_resident"
  | "no_email"
  | "manager_not_linked"
  | "lookup_failed";

export type ResidentSmsIdentity =
  | { ok: true; ctx: ResidentAgentContext }
  | { ok: false; reason: ResidentSmsIdentityFailure };

type ProfileRow = {
  id: string;
  email: string | null;
  phone: string | null;
  phone_verified_at: string | null;
  role: string | null;
  manager_id: string | null;
};

/**
 * Resolve the verified resident behind an inbound text, or explain why not.
 *
 * @param fromPhone   the inbound `From` header
 * @param ownerManagerUserId the manager who owns the work number that was texted
 */
export async function resolveResidentSmsAgentContext(
  db: SupabaseClient,
  args: { fromPhone: string; ownerManagerUserId: string },
): Promise<ResidentSmsIdentity> {
  const phone = normalizeE164(args.fromPhone);
  const ownerManagerUserId = args.ownerManagerUserId.trim();
  if (!phone || !ownerManagerUserId) return { ok: false, reason: "invalid_phone" };

  // Match the same un-normalized storage formats the SMS consent layer matches,
  // so a profile saved as "(510) 555-0142" is still found.
  //
  // The verified filter is applied IN THE QUERY, not afterwards in JS. Filtering
  // a limited page in memory lets the limit hide a second verified account: with
  // an in-memory filter and `.limit(10)`, an 11th matching row is never fetched,
  // so a page holding exactly one verified profile passes the ambiguity guard
  // while another verified profile for the same number exists. Pushing it down
  // means `limit(2)` is sufficient to DETECT ambiguity and can never mask it.
  const { data: rows, error } = await db
    .from("profiles")
    .select("id, email, phone, phone_verified_at, role, manager_id")
    .in("phone", profilePhoneVariants(phone))
    .not("phone_verified_at", "is", null)
    .limit(2);
  if (error) return { ok: false, reason: "lookup_failed" };

  // Fail closed on ambiguity: if two accounts claim one verified number we
  // cannot say which human is texting, so nobody gets resident scope.
  const verified = (rows ?? []).filter((row) =>
    String((row as ProfileRow).id ?? "").trim(),
  ) as ProfileRow[];
  if (verified.length !== 1) return { ok: false, reason: "no_verified_profile" };
  const profile = verified[0];

  const userId = String(profile.id).trim();
  const email = String(profile.email ?? "").trim().toLowerCase();
  if (!email) return { ok: false, reason: "no_email" };

  // `profiles.role` is legacy and singular; `profile_roles` is the source of
  // truth for a multi-role account (a manager who also rents somewhere).
  const { data: roleRows, error: roleError } = await db
    .from("profile_roles")
    .select("role")
    .eq("user_id", userId);
  if (roleError) return { ok: false, reason: "lookup_failed" };
  const roleList = (roleRows ?? []).map((r) => String(r.role).toLowerCase());
  const legacyRole = String(profile.role ?? "").toLowerCase();
  const roles = roleList.length > 0 ? roleList : legacyRole ? [legacyRole] : [];
  if (!roles.includes("resident")) return { ok: false, reason: "not_a_resident" };

  const managerIds = await managerIdsOwningResident(db, email);
  // The tenant binding. Texting manager B never exposes manager A's resident.
  if (!managerIds.includes(ownerManagerUserId)) {
    return { ok: false, reason: "manager_not_linked" };
  }

  const [managerTier, access] = await Promise.all([
    getManagerSubscriptionTierByManagerId(ownerManagerUserId),
    loadResidentPortalAccessState({
      userId,
      role: profile.role,
      email,
      managerSubscriptionTier: null,
      managerUserId: ownerManagerUserId,
    }),
  ]);

  return {
    ok: true,
    ctx: {
      kind: "resident",
      userId,
      email,
      managerIds,
      activeManagerId: ownerManagerUserId,
      phase: access.leaseAccessUnlocked ? "approved" : "application",
      managerTier,
      landlordId: userId,
      db: db as ResidentAgentContext["db"],
    },
  };
}
