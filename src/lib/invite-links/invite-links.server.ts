import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findPropertyIdsNotOwnedByManager } from "@/lib/auth/co-manager-invite-scope";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { managerPlanAllowsCoManagerInvites } from "@/lib/co-manager-plan-access.server";
import {
  expiryIsoForOption,
  inviteLinkUnusableMessage,
  inviteLinkUnusableReason,
  maxUsesForOption,
  normalizeInviteLinkKind,
  type InviteLinkKind,
  type InviteLinkUnusableReason,
} from "@/lib/invite-links/invite-link-model";
import {
  normalizePropertyCoManagerPermissions,
  type PropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";

const TOKEN_BYTES = 32;

/**
 * `account_link_invites` is the only relationship a redeemed link can create,
 * and its `tab_kind` CHECK admits `manager` alone. Any other kind therefore has
 * nowhere to land, so both minting and redeeming refuse it rather than quietly
 * producing co-manager access under a different label.
 */
export const UNSUPPORTED_INVITE_LINK_KIND_ERROR =
  "Shareable links are only available for co-manager invites. Send a vendor invite by email instead.";

/**
 * The token is a credential, so only its digest is stored.
 *
 * Plain SHA-256 rather than a password hash on purpose: this is 256 bits of
 * CSPRNG output, not a human-chosen secret, so there is no dictionary to slow
 * down — and the digest has to be computed on every open of the link.
 */
export function hashInviteLinkToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

function mintToken(): string {
  // base64url so the whole token is one clean URL path segment.
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export type InviteLinkRow = {
  id: string;
  kind: InviteLinkKind;
  label: string | null;
  assignedPropertyIds: string[];
  propertyPermissions: PropertyCoManagerPermissions;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

type DbRow = {
  id: string;
  kind: string;
  label: string | null;
  assigned_property_ids: string[] | null;
  property_permissions: unknown;
  max_uses: number | null;
  used_count: number | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

/** Never carries the token or its hash — the row is metadata only. */
function toInviteLinkRow(row: DbRow): InviteLinkRow {
  return {
    id: String(row.id),
    kind: normalizeInviteLinkKind(row.kind),
    label: row.label,
    assignedPropertyIds: Array.isArray(row.assigned_property_ids) ? row.assigned_property_ids : [],
    propertyPermissions: normalizePropertyCoManagerPermissions(
      row.property_permissions,
      Array.isArray(row.assigned_property_ids) ? row.assigned_property_ids : [],
    ),
    maxUses: row.max_uses ?? null,
    usedCount: Number(row.used_count ?? 0),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

const LINK_COLUMNS =
  "id, kind, label, assigned_property_ids, property_permissions, max_uses, used_count, expires_at, revoked_at, created_at";

export type MintInviteLinkResult =
  | { ok: true; link: InviteLinkRow; token: string }
  | { ok: false; status: number; error: string };

/**
 * Mint a link.
 *
 * The scope is decided HERE, by the owner, and stored on the row — the person
 * who redeems it never names their own permissions. `assigned_property_ids` is
 * validated against real ownership before the row exists, the same rule the
 * addressed invite follows: a property id in a request body is a bound, not an
 * authorization.
 */
export async function mintInviteLink(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    kind?: string;
    label?: string;
    assignedPropertyIds: string[];
    propertyPermissions: unknown;
    expiryOption?: string;
    usesOption?: string;
    now?: Date;
  },
): Promise<MintInviteLinkResult> {
  const ownerUserId = input.ownerUserId.trim();
  if (!ownerUserId) return { ok: false, status: 401, error: "Sign in to create an invite link." };

  const kind = normalizeInviteLinkKind(input.kind);

  // Redeeming a link produces an `account_link_invites` row — a CO-MANAGER
  // relationship, and the only relationship this table can express. There is no
  // vendor redemption path, so a vendor link could only ever hand its opener
  // manager access, minted around the paid gate below. Refuse at the source.
  if (kind !== "manager") {
    return { ok: false, status: 400, error: UNSUPPORTED_INVITE_LINK_KIND_ERROR };
  }

  // Same paid gate the addressed invite uses. A link that cannot be redeemed is
  // worse than a refusal, because the manager only learns at the far end.
  const tier = await getEffectiveManagerSkuTier(ownerUserId);
  if (!tier.ok) {
    return { ok: false, status: 500, error: "We could not verify your plan. Try again in a moment." };
  }
  if (!managerPlanAllowsCoManagerInvites({ tier: tier.tier })) {
    return {
      ok: false,
      status: 403,
      error: "Co-manager invites are available on Pro and Business. Upgrade to add a co-manager.",
    };
  }

  const propertyIds = [...new Set(input.assignedPropertyIds.map((id) => String(id).trim()).filter(Boolean))];
  if (propertyIds.length === 0) {
    return { ok: false, status: 400, error: "Choose at least one property this link grants access to." };
  }

  const ownership = await findPropertyIdsNotOwnedByManager(db, ownerUserId, propertyIds);
  if (!ownership.ok) {
    return { ok: false, status: 500, error: "Could not verify property ownership. Try again." };
  }
  if (ownership.unowned.length > 0) {
    // Refuse the whole request rather than silently dropping ids: a partial
    // grant is the failure mode, not the safe outcome.
    return { ok: false, status: 403, error: "One or more selected properties are not yours to share." };
  }

  const permissions = normalizePropertyCoManagerPermissions(input.propertyPermissions, propertyIds);
  const token = mintToken();

  const { data, error } = await db
    .from("manager_invite_links")
    .insert({
      owner_user_id: ownerUserId,
      kind,
      token_hash: hashInviteLinkToken(token),
      label: input.label?.trim() || null,
      assigned_property_ids: propertyIds,
      property_permissions: permissions,
      max_uses: maxUsesForOption(input.usesOption),
      expires_at: expiryIsoForOption(input.expiryOption, input.now ?? new Date()),
    })
    .select(LINK_COLUMNS)
    .maybeSingle();

  if (error || !data) {
    return { ok: false, status: 500, error: error?.message ?? "Could not create the invite link." };
  }
  // The only moment the raw token exists outside the opener's URL bar.
  return { ok: true, link: toInviteLinkRow(data as DbRow), token };
}

export async function listInviteLinks(
  db: SupabaseClient,
  ownerUserId: string,
): Promise<InviteLinkRow[]> {
  const { data } = await db
    .from("manager_invite_links")
    .select(LINK_COLUMNS)
    .eq("owner_user_id", ownerUserId.trim())
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  return (data ?? []).map((row) => toInviteLinkRow(row as DbRow));
}

/** Turning a link off is scoped to its owner — the id alone is not authority. */
export async function revokeInviteLink(
  db: SupabaseClient,
  input: { ownerUserId: string; linkId: string },
): Promise<{ ok: boolean; error?: string }> {
  const { error, data } = await db
    .from("manager_invite_links")
    .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", input.linkId.trim())
    .eq("owner_user_id", input.ownerUserId.trim())
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "That invite link no longer exists." };
  return { ok: true };
}

export type InviteLinkPreview = {
  kind: InviteLinkKind;
  ownerUserId: string;
  ownerName: string;
  propertyLabels: string[];
  unusableReason: InviteLinkUnusableReason | null;
};

async function loadLinkByToken(db: SupabaseClient, token: string) {
  const { data } = await db
    .from("manager_invite_links")
    .select(`${LINK_COLUMNS}, owner_user_id`)
    .eq("token_hash", hashInviteLinkToken(token))
    .maybeSingle();
  return (data as (DbRow & { owner_user_id: string }) | null) ?? null;
}

/**
 * What the opener is shown BEFORE they accept.
 *
 * Deliberately thin: the inviter's name and the properties, never the owner's
 * other holdings and never the raw permission map. Anyone with the URL can call
 * this, so it must not become a way to enumerate a manager's portfolio.
 */
export async function previewInviteLink(
  db: SupabaseClient,
  token: string,
  now: Date = new Date(),
): Promise<InviteLinkPreview | null> {
  const link = await loadLinkByToken(db, token);
  if (!link) return null;

  const [{ data: owner }, { data: properties }] = await Promise.all([
    db.from("profiles").select("full_name").eq("id", link.owner_user_id).maybeSingle(),
    db
      .from("manager_property_records")
      .select("id, row_data")
      .in("id", link.assigned_property_ids ?? []),
  ]);

  const labels = (properties ?? []).map((row) => {
    const data = (row as { row_data?: { buildingName?: string; address?: string } }).row_data ?? {};
    return data.buildingName?.trim() || data.address?.trim() || "A property";
  });

  return {
    kind: normalizeInviteLinkKind(link.kind),
    ownerUserId: String(link.owner_user_id),
    ownerName: String(owner?.full_name ?? "").trim() || "A property manager",
    propertyLabels: labels,
    unusableReason: inviteLinkUnusableReason(
      {
        expiresAt: link.expires_at,
        revokedAt: link.revoked_at,
        maxUses: link.max_uses,
        usedCount: link.used_count,
      },
      now,
    ),
  };
}

export type RedeemInviteLinkResult =
  | { ok: true; inviteId: string; alreadyRedeemed: boolean }
  | { ok: false; status: number; error: string };

/**
 * Spend a use and produce an ADDRESSED invite the opener then accepts.
 *
 * Redeeming does not itself grant anything. It mints a pending
 * `account_link_invites` row naming the opener, and the existing accept path —
 * which re-derives ownership, re-checks both plans and writes the relationship
 * mirrors — is what actually links the accounts. That keeps one implementation
 * of "become a co-manager" instead of a second one reachable only by link, and
 * it means the opener still sees and agrees to what they are joining.
 */
export async function redeemInviteLink(
  db: SupabaseClient,
  input: { token: string; redeemerUserId: string; now?: Date },
): Promise<RedeemInviteLinkResult> {
  const now = input.now ?? new Date();
  const redeemerUserId = input.redeemerUserId.trim();
  if (!redeemerUserId) return { ok: false, status: 401, error: "Sign in to accept this invite." };

  const link = await loadLinkByToken(db, input.token);
  if (!link) return { ok: false, status: 404, error: "That invite link is not valid." };

  if (String(link.owner_user_id) === redeemerUserId) {
    return { ok: false, status: 400, error: "This is your own invite link." };
  }

  // Refused BEFORE a use is spent: a link that can never be honoured must not
  // burn the budget its owner set, and it must never fall through to the
  // co-manager insert below.
  if (normalizeInviteLinkKind(link.kind) !== "manager") {
    return { ok: false, status: 400, error: UNSUPPORTED_INVITE_LINK_KIND_ERROR };
  }

  const unusable = inviteLinkUnusableReason(
    {
      expiresAt: link.expires_at,
      revokedAt: link.revoked_at,
      maxUses: link.max_uses,
      usedCount: link.used_count,
    },
    now,
  );
  if (unusable) return { ok: false, status: 410, error: inviteLinkUnusableMessage(unusable) };

  // Already redeemed by this person: hand back the invite they already have
  // rather than spending another use or creating a second link.
  const { data: existingRedemption } = await db
    .from("manager_invite_link_redemptions")
    .select("id")
    .eq("link_id", link.id)
    .eq("redeemed_by_user_id", redeemerUserId)
    .maybeSingle();

  const { data: existingInvite } = await db
    .from("account_link_invites")
    .select("id")
    .eq("inviter_user_id", link.owner_user_id)
    .eq("invitee_user_id", redeemerUserId)
    .in("status", ["pending", "accepted"])
    .maybeSingle();

  if (existingRedemption && existingInvite) {
    return { ok: true, inviteId: String(existingInvite.id), alreadyRedeemed: true };
  }

  // Ownership is re-derived HERE, against what the owner holds now — the link
  // may have been minted before a property changed hands. Refuse rather than
  // narrow: a silent partial grant is the failure mode being closed.
  const ownership = await findPropertyIdsNotOwnedByManager(
    db,
    String(link.owner_user_id),
    link.assigned_property_ids ?? [],
  );
  if (!ownership.ok) {
    return { ok: false, status: 500, error: "Could not verify this invite. Try again in a moment." };
  }
  if (ownership.unowned.length > 0) {
    return {
      ok: false,
      status: 403,
      error: "This invite points at a property its owner no longer manages. Ask for a new link.",
    };
  }

  for (const [userId, who] of [
    [String(link.owner_user_id), "The manager who shared this link"],
    [redeemerUserId, "You"],
  ] as const) {
    const tier = await getEffectiveManagerSkuTier(userId);
    if (!tier.ok) {
      return { ok: false, status: 500, error: "We could not verify plan eligibility. Try again in a moment." };
    }
    if (!managerPlanAllowsCoManagerInvites({ tier: tier.tier })) {
      return {
        ok: false,
        status: 403,
        error: `${who} need${who === "You" ? "" : "s"} a Pro or Business plan for co-manager access.`,
      };
    }
  }

  // Spend the use with a CONDITIONAL update so two people opening a one-time
  // link at the same moment cannot both win: the second update matches no row.
  if (link.max_uses != null) {
    const { data: claimed } = await db
      .from("manager_invite_links")
      .update({ used_count: (link.used_count ?? 0) + 1, updated_at: now.toISOString() })
      .eq("id", link.id)
      .eq("used_count", link.used_count ?? 0)
      .lt("used_count", link.max_uses)
      .select("id")
      .maybeSingle();
    if (!claimed) {
      return { ok: false, status: 409, error: "This invite link was just used up. Ask for a new one." };
    }
  } else {
    await db
      .from("manager_invite_links")
      .update({ used_count: (link.used_count ?? 0) + 1, updated_at: now.toISOString() })
      .eq("id", link.id);
  }

  // A use that produced no invite is a use nobody can ever redeem, so every
  // failure below hands it back rather than leaving a one-time link spent.
  const releaseSpentUse = async () => {
    await db
      .from("manager_invite_links")
      .update({ used_count: link.used_count ?? 0, updated_at: new Date().toISOString() })
      .eq("id", link.id)
      .eq("used_count", (link.used_count ?? 0) + 1);
  };

  const { error: redemptionError } = await db
    .from("manager_invite_link_redemptions")
    .insert({ link_id: link.id, redeemed_by_user_id: redeemerUserId });
  // A duplicate here means a concurrent redeem by the same person — not a
  // failure, and the use we just spent is theirs either way.
  if (redemptionError && redemptionError.code !== "23505") {
    await releaseSpentUse();
    return { ok: false, status: 500, error: "Could not record this invite. Try again." };
  }
  const recordedRedemption = !existingRedemption && !redemptionError;

  if (existingInvite) {
    return { ok: true, inviteId: String(existingInvite.id), alreadyRedeemed: false };
  }

  const [{ data: inviterProfile }, { data: inviteeProfile }] = await Promise.all([
    db.from("profiles").select("axis_id, full_name").eq("id", link.owner_user_id).maybeSingle(),
    db.from("profiles").select("axis_id, full_name").eq("id", redeemerUserId).maybeSingle(),
  ]);

  const { data: invite, error: inviteError } = await db
    .from("account_link_invites")
    .insert({
      inviter_user_id: link.owner_user_id,
      invitee_user_id: redeemerUserId,
      inviter_axis_id: String(inviterProfile?.axis_id ?? "").trim(),
      invitee_axis_id: String(inviteeProfile?.axis_id ?? "").trim(),
      inviter_display_name: inviterProfile?.full_name ?? null,
      invitee_display_name: inviteeProfile?.full_name ?? null,
      // `not null` with no default, and the CHECK admits only this value. Omitting
      // it made every first redemption a 23502 that still spent a use.
      tab_kind: "manager",
      status: "pending",
      assigned_property_ids: link.assigned_property_ids ?? [],
      property_co_manager_permissions: normalizePropertyCoManagerPermissions(
        link.property_permissions,
        link.assigned_property_ids ?? [],
      ),
    })
    .select("id")
    .maybeSingle();

  if (inviteError || !invite) {
    if (recordedRedemption) {
      await db
        .from("manager_invite_link_redemptions")
        .delete()
        .eq("link_id", link.id)
        .eq("redeemed_by_user_id", redeemerUserId);
    }
    await releaseSpentUse();
    return { ok: false, status: 500, error: inviteError?.message ?? "Could not create the invite." };
  }
  return { ok: true, inviteId: String(invite.id), alreadyRedeemed: false };
}
