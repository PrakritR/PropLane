/**
 * Resident agent context for an INBOX turn.
 *
 * `resolveResidentAgentContext` reads the current request's session, which a
 * background responder does not have, and `resolveResidentSmsAgentContext` is
 * keyed on a verified phone number, which an inbox message does not carry. This
 * is the same context assembled from the pair the inbox does have: the
 * resident's email and the manager who owns the thread.
 *
 * The tenant binding is identical to the SMS path and is the whole point of the
 * function: a resident is only ever given scope against a manager who actually
 * has them, so a thread cannot be used to reach another manager's data.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getManagerSubscriptionTierByManagerId } from "@/lib/manager-access-server";
import { loadResidentPortalAccessState } from "@/lib/resident-portal-access";
import { managerIdsOwningResident } from "@/lib/resident-manager-scope";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";

export type ResidentInboxIdentity =
  | { ok: true; ctx: ResidentAgentContext }
  | { ok: false; reason: ResidentInboxIdentityFailure };

export type ResidentInboxIdentityFailure =
  | "invalid_input"
  | "lookup_failed"
  | "no_profile"
  | "not_a_resident"
  | "manager_not_linked";

type ProfileRow = { id?: unknown; email?: unknown; role?: unknown };

export async function resolveResidentInboxAgentContext(
  db: SupabaseClient,
  args: { residentEmail: string; ownerManagerUserId: string },
): Promise<ResidentInboxIdentity> {
  const email = args.residentEmail.trim().toLowerCase();
  const ownerManagerUserId = args.ownerManagerUserId.trim();
  if (!email.includes("@") || !ownerManagerUserId) return { ok: false, reason: "invalid_input" };

  // `limit(2)` so two accounts sharing an address are DETECTED rather than
  // silently resolved to whichever row came back first.
  const { data: rows, error } = await db
    .from("profiles")
    .select("id, email, role")
    .eq("email", email)
    .limit(2);
  if (error) return { ok: false, reason: "lookup_failed" };

  const matches = (rows ?? []) as ProfileRow[];
  if (matches.length !== 1) return { ok: false, reason: "no_profile" };
  const profile = matches[0]!;
  const userId = String(profile.id ?? "").trim();
  if (!userId) return { ok: false, reason: "no_profile" };

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
  // The tenant binding. A thread owned by manager B never grants scope against
  // manager A's data.
  if (!managerIds.includes(ownerManagerUserId)) {
    return { ok: false, reason: "manager_not_linked" };
  }

  const [managerTier, access] = await Promise.all([
    getManagerSubscriptionTierByManagerId(ownerManagerUserId),
    loadResidentPortalAccessState({
      userId,
      role: profile.role as string | null | undefined,
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
