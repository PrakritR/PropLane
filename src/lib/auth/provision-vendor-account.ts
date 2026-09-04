import { randomBytes } from "node:crypto";
import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import { migratePortalUserId } from "@/lib/auth/migrate-portal-user-id";
import { primaryRoleWhenAddingVendor } from "@/lib/auth/profile-primary-role";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { generateAxisId } from "@/lib/manager-id";
import { makeVendorId } from "@/lib/manager-vendors-storage";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Opaque, unguessable, single-use invite token — stored on the row, never derived from the email. */
export function generateVendorInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export type VendorInviteRow = {
  id: string;
  manager_user_id: string;
  vendor_directory_id: string | null;
  vendor_email: string;
  vendor_name: string | null;
  expires_at?: string | null;
};

const VENDOR_INVITE_COLUMNS = "id, manager_user_id, vendor_directory_id, vendor_email, vendor_name, expires_at";

/**
 * Fail closed on the TTL, for every lookup. This was `if (invite.expires_at && …)`
 * on the token path only, so a NULL expiry skipped the check entirely — and
 * `vendor_invites` was directly INSERT-able by any authenticated user, who could
 * therefore mint a never-expiring invite for an email they do not control and
 * redeem it into a pre-confirmed account. The grant is revoked in
 * 20260722123000_lock_role_grant_surface.sql and `expires_at` is now NOT NULL;
 * this keeps redemption safe regardless, and expiry is a revocation signal that
 * must hold on the self-serve email path too.
 */
function redeemableInvite(invite: VendorInviteRow | null): VendorInviteRow | null {
  if (!invite) return null;
  const expiresAt = invite.expires_at ? new Date(invite.expires_at).getTime() : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  return invite;
}

/**
 * Claim a pending invite ATOMICALLY, before anything is provisioned.
 *
 * The invite used to be flipped to `accepted` at the very END of provisioning,
 * so two concurrent redemptions of the same token both passed the
 * `status = "pending"` read and both proceeded — the token was single-use only
 * by convention. This is a compare-and-swap: the `status = "pending"` predicate
 * is in the WHERE clause, so exactly one caller wins and the loser gets no row.
 *
 * The winner owns the invite for the rest of the request; `releaseVendorInvite`
 * hands it back if provisioning then fails, so a legitimate retry is not locked
 * out by an error that was nobody's fault.
 */
export async function claimVendorInvite(
  supabase: SupabaseClient,
  inviteId: string,
  acceptedUserId: string | null,
): Promise<boolean> {
  const { data } = await supabase
    .from("vendor_invites")
    .update({
      status: "accepted",
      accepted_user_id: acceptedUserId,
      accepted_at: new Date().toISOString(),
    })
    .eq("id", inviteId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  return Boolean(data);
}

/** Hand a claimed invite back when provisioning failed, so it can be retried. */
export async function releaseVendorInvite(supabase: SupabaseClient, inviteId: string): Promise<void> {
  await supabase
    .from("vendor_invites")
    .update({ status: "pending", accepted_user_id: null, accepted_at: null })
    .eq("id", inviteId)
    .eq("status", "accepted");
}

/**
 * Exact-match only — an `ilike` pattern here would let a signup email containing
 * `%`/`_` wildcard characters match (and hijack) an unrelated pending invite.
 */
export async function findPendingVendorInviteByEmail(
  supabase: SupabaseClient,
  email: string,
): Promise<VendorInviteRow | null> {
  const { data, error } = await supabase
    .from("vendor_invites")
    .select(VENDOR_INVITE_COLUMNS)
    .eq("status", "pending")
    .eq("vendor_email", email)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return redeemableInvite((data as VendorInviteRow | null) ?? null);
}

/**
 * Why a vendor finished signup with no linked manager. There is more than one
 * way to get here and every one of them must say so — landing in the portal
 * unlinked with no explanation is the state this reporting exists to prevent.
 */
export type VendorUnlinkedReason = "invite_expired" | "invite_revoked";

/**
 * Two variants per reason: the account either exists already or is still
 * waiting on an emailed confirmation link. Telling someone "your account was
 * created" on the "click the link to finish creating your account" screen is a
 * contradiction, so each screen gets copy that is true for it.
 */
const VENDOR_UNLINKED_NOTICES: Record<VendorUnlinkedReason, { confirmed: string; awaitingConfirmation: string }> = {
  invite_expired: {
    confirmed:
      "That invite link has expired — ask your manager to send a new one. Your account is ready, but it is not linked to them yet.",
    awaitingConfirmation:
      "That invite link has expired — ask your manager to send a new one. Confirm your email to finish setting up, then they can link you.",
  },
  invite_revoked: {
    confirmed:
      "That invite is no longer valid — ask your manager to send a new one. Your account is ready, but it is not linked to them yet.",
    awaitingConfirmation:
      "That invite is no longer valid — ask your manager to send a new one. Confirm your email to finish setting up, then they can link you.",
  },
};

export function vendorUnlinkedNotice(
  reason: VendorUnlinkedReason | null | undefined,
  opts: { confirmed: boolean },
): string | null {
  if (!reason) return null;
  const copy = VENDOR_UNLINKED_NOTICES[reason];
  return opts.confirmed ? copy.confirmed : copy.awaitingConfirmation;
}

export type VendorInviteEmailLookup =
  | { kind: "none" }
  | { kind: "redeemable"; invite: VendorInviteRow }
  | { kind: "expired" };

/**
 * The TTL must fail closed, but "expired" and "never invited" are different
 * outcomes for the person signing up: silently treating an expired invite as no
 * invite drops the vendor into the portal with no linked manager and nothing to
 * self-diagnose. Distinguish the two so the self-serve path can say the same
 * thing the token path says instead of provisioning a quietly wrong account.
 * The second query only runs when nothing redeemable was found.
 */
export async function lookupVendorInviteByEmail(
  supabase: SupabaseClient,
  email: string,
): Promise<VendorInviteEmailLookup> {
  const redeemable = await findPendingVendorInviteByEmail(supabase, email);
  if (redeemable) return { kind: "redeemable", invite: redeemable };

  const { data, error } = await supabase
    .from("vendor_invites")
    .select("id")
    .eq("status", "pending")
    .eq("vendor_email", email)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? { kind: "expired" } : { kind: "none" };
}

/** Resolves an invite from its emailed single-use token — never trust a client-supplied email instead. */
export async function findPendingVendorInviteByToken(
  supabase: SupabaseClient,
  token: string,
): Promise<VendorInviteRow | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;

  const { data, error } = await supabase
    .from("vendor_invites")
    .select(VENDOR_INVITE_COLUMNS)
    .eq("status", "pending")
    .eq("invite_token", trimmed)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return redeemableInvite((data as VendorInviteRow | null) ?? null);
}

/** Defense in depth: a directory row's owning manager must match the invite that names it. */
async function directoryBelongsToManager(
  supabase: SupabaseClient,
  vendorDirectoryId: string,
  managerUserId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("manager_vendor_records")
    .select("manager_user_id")
    .eq("id", vendorDirectoryId)
    .maybeSingle();
  return data?.manager_user_id === managerUserId;
}

export type ProvisionVendorResult =
  | { ok: true; axisId: string; linkedManagerId: string | null; unlinkedReason: VendorUnlinkedReason | null }
  | { ok: false; status: number; error: string };

/**
 * Vendor signup — links the new vendor user to the inviting manager's vendor directory
 * row when an invite applies. Pass `invite` when it was already resolved from a signed
 * token (never re-derive it from a client-supplied email in that case); omit it to fall
 * back to an exact-match lookup by the account's own email (self-serve convenience link).
 */
export async function provisionVendorAccountByEmail(
  supabase: SupabaseClient,
  opts: {
    userId: string;
    email: string;
    fullName?: string | null;
    invite?: VendorInviteRow | null;
    /**
     * Defaults to true (invite links and existing-account password verification are
     * already a possession proof). Pass false only when the caller is about to send its
     * own Supabase email-confirmation link — confirming here would skip that check.
     */
    confirmEmail?: boolean;
  },
): Promise<ProvisionVendorResult> {
  const normalEmail = opts.email.trim().toLowerCase();
  if (!normalEmail.includes("@")) {
    return { ok: false, status: 400, error: "Enter a valid email address." };
  }

  let invite: VendorInviteRow | null;
  let unlinkedReason: VendorUnlinkedReason | null = null;
  if (opts.invite !== undefined) {
    invite = opts.invite;
  } else {
    const lookup = await lookupVendorInviteByEmail(supabase, normalEmail);
    // An expired invite is never redeemed, but it must not fail the signup
    // either: the caller has already created the auth user by this point, so
    // refusing here deletes the account and every retry fails identically.
    // Provision unlinked and report it, so the vendor is told why.
    if (lookup.kind === "expired") unlinkedReason = "invite_expired";
    invite = lookup.kind === "redeemable" ? lookup.invite : null;
  }

  if (invite?.vendor_directory_id) {
    const ownershipOk = await directoryBelongsToManager(supabase, invite.vendor_directory_id, invite.manager_user_id);
    if (!ownershipOk) {
      // Directory row was reassigned/deleted since the invite was sent — the invite is
      // stale rather than actionable. Consume it so it can't be retried and proceed as if
      // no invite applied.
      await supabase.from("vendor_invites").update({ status: "cancelled" }).eq("id", invite.id);
      invite = null;
      unlinkedReason = "invite_revoked";
    }
  }

  const existingAuthId = await findAuthUserIdByEmail(supabase, normalEmail);
  if (existingAuthId && existingAuthId !== opts.userId) {
    await migratePortalUserId(supabase, existingAuthId, opts.userId);
  }

  const { data: existingAuth } = await supabase.auth.admin.getUserById(opts.userId);
  const metadata = existingAuth.user?.user_metadata as Record<string, unknown> | undefined;
  const axisId = metadata?.axis_id?.toString() ?? generateAxisId();

  await supabase.auth.admin.updateUserById(opts.userId, {
    ...(opts.confirmEmail === false ? {} : { email_confirm: true }),
    user_metadata: {
      ...(metadata ?? {}),
      role: "vendor",
      axis_id: axisId,
    },
  });

  const { data: existingProfile } = await supabase.from("profiles").select("*").eq("id", opts.userId).maybeSingle();

  const { error: upErr } = await supabase.from("profiles").upsert(
    {
      id: opts.userId,
      email: normalEmail,
      role: primaryRoleWhenAddingVendor(existingProfile?.role as string | undefined),
      full_name: opts.fullName?.trim() || existingProfile?.full_name || invite?.vendor_name || null,
      manager_id: existingProfile?.manager_id?.trim() || axisId,
    },
    { onConflict: "id" },
  );
  if (upErr) {
    return { ok: false, status: 500, error: upErr.message };
  }

  await ensureProfileRoleRow(supabase, opts.userId, "vendor");

  let linkedManagerId: string | null = null;

  if (invite) {
    linkedManagerId = invite.manager_user_id;

    if (invite.vendor_directory_id) {
      await supabase
        .from("manager_vendor_records")
        .update({ vendor_user_id: opts.userId, updated_at: new Date().toISOString() })
        .eq("id", invite.vendor_directory_id);
      await supabase
        .from("work_order_vendor_offers")
        .update({ vendor_user_id: opts.userId, updated_at: new Date().toISOString() })
        .eq("vendor_directory_id", invite.vendor_directory_id)
        .is("vendor_user_id", null);
    } else {
      const directoryId = makeVendorId();
      await supabase.from("manager_vendor_records").upsert(
        {
          id: directoryId,
          manager_user_id: invite.manager_user_id,
          vendor_user_id: opts.userId,
          row_data: {
            id: directoryId,
            managerUserId: invite.manager_user_id,
            name: invite.vendor_name?.trim() || opts.fullName?.trim() || normalEmail,
            trade: "",
            phone: "",
            email: normalEmail,
            notes: "",
            active: true,
          },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
    }

    // Idempotent: the caller claims the invite up front (claimVendorInvite), so
    // this only fills in the accepted user for paths that did not know it yet.
    // Scoped to `accepted` so it can never resurrect a released or revoked row.
    await supabase
      .from("vendor_invites")
      .update({ status: "accepted", accepted_user_id: opts.userId, accepted_at: new Date().toISOString() })
      .eq("id", invite.id)
      .eq("status", "accepted");
  }

  return { ok: true, axisId, linkedManagerId, unlinkedReason };
}
