import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findPropertyIdsNotOwnedByManager } from "@/lib/auth/co-manager-invite-scope";
import {
  actorCanManageInviteLink,
  capTeamInvitePermissionsForDelegate,
  resolveTeamInviteDelegate,
  teamInviteOwnerIdsForActor,
} from "@/lib/auth/co-manager-team-invite.server";
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
 * A redeemed link lands in exactly one of two places, decided by its kind:
 * `manager` mints an `account_link_invites` row (co-manager), `resident` files
 * a `resident_invite_claims` row (an assertion the manager then approves).
 *
 * `vendor` has neither. It would have nowhere to land but the co-manager table,
 * so a vendor link could only ever hand its opener manager access under a
 * different label — refused at both ends rather than quietly honoured.
 */
export const UNSUPPORTED_INVITE_LINK_KIND_ERROR =
  "Shareable links are only available for co-manager and resident invites. Send a vendor invite by email instead.";

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
  /** Resident links only: the single room the link narrows to, if any. */
  assignedRoomId: string | null;
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
  assigned_room_id: string | null;
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
    assignedRoomId: row.assigned_room_id?.trim() || null,
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
  "id, kind, label, assigned_property_ids, assigned_room_id, property_permissions, max_uses, used_count, expires_at, revoked_at, created_at";

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
    actorUserId: string;
    kind?: string;
    label?: string;
    assignedPropertyIds: string[];
    assignedRoomId?: string;
    propertyPermissions: unknown;
    expiryOption?: string;
    usesOption?: string;
    now?: Date;
  },
): Promise<MintInviteLinkResult> {
  const actorUserId = input.actorUserId.trim();
  if (!actorUserId) return { ok: false, status: 401, error: "Sign in to create an invite link." };

  const kind = normalizeInviteLinkKind(input.kind);

  // `vendor` has no redemption path of its own, so it could only ever land in
  // the co-manager table — manager access under a different label, minted
  // around the paid gate below. Refuse at the source.
  if (kind === "vendor") {
    return { ok: false, status: 400, error: UNSUPPORTED_INVITE_LINK_KIND_ERROR };
  }

  const propertyIds = [...new Set(input.assignedPropertyIds.map((id) => String(id).trim()).filter(Boolean))];
  // Who this link is really FOR. A co-manager with Team edit may mint on the
  // owner's behalf (PRP-400), so the owner is resolved and authorized here
  // rather than taken from the caller — for every kind, resident included.
  const delegate = await resolveTeamInviteDelegate(db, actorUserId, propertyIds);
  if (!delegate.ok) {
    return { ok: false, status: delegate.status, error: delegate.error };
  }
  const ownerUserId = delegate.ownerUserId;

  // The co-manager paid gate, and ONLY for co-manager links. A resident is a
  // person who lives in the property, not a seat on the owner's plan, so
  // charging for the ability to move existing tenants onto PropLane would gate
  // the migration itself. A link that cannot be redeemed is worse than a
  // refusal, because the manager only learns at the far end.
  if (kind === "manager") {
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

  // A resident link grants no modules, so it stores an EMPTY permission map and
  // never runs the co-manager capping — there is nothing to cap, and leaving a
  // populated map on the row would be a grant waiting for a future reader to
  // honour. A co-manager link still caps to what the acting delegate holds.
  let permissions: PropertyCoManagerPermissions | Record<string, never> = {};
  if (kind === "manager") {
    const cappedPermissions = await capTeamInvitePermissionsForDelegate(
      db,
      actorUserId,
      ownerUserId,
      propertyIds,
      normalizePropertyCoManagerPermissions(input.propertyPermissions, propertyIds),
    );
    if (!cappedPermissions.ok) {
      return { ok: false, status: cappedPermissions.status, error: cappedPermissions.error };
    }
    permissions = cappedPermissions.permissions;
  }
  // A room narrows a resident link; it is meaningless on a co-manager one,
  // whose scope is whole properties.
  const roomId = kind === "resident" ? input.assignedRoomId?.trim() || null : null;
  const token = mintToken();

  const { data, error } = await db
    .from("manager_invite_links")
    .insert({
      owner_user_id: ownerUserId,
      kind,
      token_hash: hashInviteLinkToken(token),
      label: input.label?.trim() || null,
      assigned_property_ids: propertyIds,
      assigned_room_id: roomId,
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

export async function listInviteLinksForActor(db: SupabaseClient, actorUserId: string): Promise<InviteLinkRow[]> {
  const owners = [...(await teamInviteOwnerIdsForActor(db, actorUserId))];
  if (owners.length === 0) return [];
  const { data } = await db
    .from("manager_invite_links")
    .select(`${LINK_COLUMNS}, owner_user_id`)
    .in("owner_user_id", owners)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  const rows = (data ?? []) as (DbRow & { owner_user_id: string })[];
  const visible: InviteLinkRow[] = [];
  for (const row of rows) {
    const ownerUserId = String(row.owner_user_id ?? "").trim();
    const link = toInviteLinkRow(row);
    const allowed = await actorCanManageInviteLink(db, actorUserId, {
      ownerUserId,
      assignedPropertyIds: link.assignedPropertyIds,
    });
    if (allowed) visible.push(link);
  }
  return visible;
}

type InviteLinkRowWithOwner = InviteLinkRow & { ownerUserId: string };

async function loadInviteLinkById(db: SupabaseClient, linkId: string): Promise<InviteLinkRowWithOwner | null> {
  const { data } = await db
    .from("manager_invite_links")
    .select(`${LINK_COLUMNS}, owner_user_id`)
    .eq("id", linkId.trim())
    .maybeSingle();
  if (!data) return null;
  const row = data as DbRow & { owner_user_id: string };
  return { ...toInviteLinkRow(row), ownerUserId: String(row.owner_user_id) };
}

export type RotateInviteLinkResult =
  | { ok: true; link: InviteLinkRow; token: string }
  | { ok: false; status: number; error: string };

/** Rotate the token so the opener can copy a fresh URL. Invalidates the previous link. */
export async function rotateInviteLinkToken(
  db: SupabaseClient,
  input: { actorUserId: string; linkId: string; now?: Date },
): Promise<RotateInviteLinkResult> {
  const link = await loadInviteLinkById(db, input.linkId);
  if (!link) return { ok: false, status: 404, error: "That invite link no longer exists." };

  const unusable = inviteLinkUnusableReason(
    {
      expiresAt: link.expiresAt,
      revokedAt: link.revokedAt,
      maxUses: link.maxUses,
      usedCount: link.usedCount,
    },
    input.now ?? new Date(),
  );
  if (unusable) {
    return { ok: false, status: 409, error: inviteLinkUnusableMessage(unusable) };
  }

  const allowed = await actorCanManageInviteLink(db, input.actorUserId, {
    ownerUserId: link.ownerUserId,
    assignedPropertyIds: link.assignedPropertyIds,
  });
  if (!allowed) {
    return { ok: false, status: 403, error: "You do not have permission to copy this invite link." };
  }

  const token = mintToken();
  const { data, error } = await db
    .from("manager_invite_links")
    .update({ token_hash: hashInviteLinkToken(token), updated_at: new Date().toISOString() })
    .eq("id", link.id)
    .is("revoked_at", null)
    .select(LINK_COLUMNS)
    .maybeSingle();
  if (error || !data) {
    return { ok: false, status: 500, error: "Could not refresh the invite link." };
  }
  return { ok: true, link: toInviteLinkRow(data as DbRow), token };
}

/** Turning a link off is scoped to its owner — the id alone is not authority. */
export async function revokeInviteLink(
  db: SupabaseClient,
  input: { actorUserId: string; linkId: string },
): Promise<{ ok: boolean; error?: string; status?: number }> {
  const link = await loadInviteLinkById(db, input.linkId);
  if (!link) return { ok: false, status: 404, error: "That invite link no longer exists." };
  const allowed = await actorCanManageInviteLink(db, input.actorUserId, {
    ownerUserId: link.ownerUserId,
    assignedPropertyIds: link.assignedPropertyIds,
  });
  if (!allowed) return { ok: false, status: 403, error: "You do not have permission to turn off this invite link." };

  const { error, data } = await db
    .from("manager_invite_links")
    .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", input.linkId.trim())
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

  const kind = normalizeInviteLinkKind(link.kind);
  // A property record's `row_data` is routinely EMPTY on the server — the name a
  // manager sees in their own list is built from browser-local listings, not
  // this row (AGENTS.md, "only Properties reads ownership"). For a co-manager
  // that produced a vague "A property" and nobody minded; for a RESIDENT being
  // asked "is this your home?", an unnamed building makes the question
  // unanswerable. The link's own label is the manager's chosen name for the
  // property at mint time, so it fills the gap for resident links.
  //
  // Resident kind only: a co-manager link's label is a freeform note about the
  // person being invited ("Sarah — weekends"), not a property name.
  const linkLabel = kind === "resident" ? (link.label?.trim() ?? "") : "";
  const labels = (properties ?? []).map((row) => {
    const data = (row as { row_data?: { buildingName?: string; address?: string } }).row_data ?? {};
    return data.buildingName?.trim() || data.address?.trim() || linkLabel || "A property";
  });
  // No property row at all (a stale id, or a record never mirrored to the
  // server) still leaves a resident link able to name its building.
  if (labels.length === 0 && linkLabel) labels.push(linkLabel);

  return {
    kind,
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
  | { ok: true; kind: "manager"; inviteId: string; alreadyRedeemed: boolean }
  | { ok: true; kind: "resident"; claimId: string; alreadyRedeemed: boolean }
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
  const linkKind = normalizeInviteLinkKind(link.kind);
  if (linkKind === "vendor") {
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

  /**
   * Ownership is re-derived HERE, against what the owner holds now — the link
   * may have been minted before a property changed hands. Refuse rather than
   * narrow: a silent partial grant is the failure mode being closed. Both kinds
   * need it, so it is one function rather than two copies that can drift.
   */
  const verifyOwnershipStillHolds = async (): Promise<
    { ok: true } | { ok: false; status: number; error: string }
  > => {
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
    return { ok: true };
  };

  /**
   * Spend the use with a CONDITIONAL update so two people opening a one-time
   * link at the same moment cannot both win: the second update matches no row.
   */
  const spendUse = async (): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
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
      return { ok: true };
    }
    await db
      .from("manager_invite_links")
      .update({ used_count: (link.used_count ?? 0) + 1, updated_at: now.toISOString() })
      .eq("id", link.id);
    return { ok: true };
  };

  /** A use that produced nothing is a use nobody can ever redeem. */
  const releaseSpentUse = async () => {
    await db
      .from("manager_invite_links")
      .update({ used_count: link.used_count ?? 0, updated_at: new Date().toISOString() })
      .eq("id", link.id)
      .eq("used_count", (link.used_count ?? 0) + 1);
  };

  if (linkKind === "resident") {
    return redeemResidentLink({
      db,
      link,
      redeemerUserId,
      alreadyRedeemed: Boolean(existingRedemption),
      verifyOwnershipStillHolds,
      spendUse,
      releaseSpentUse,
    });
  }

  const { data: existingInvite } = await db
    .from("account_link_invites")
    .select("id")
    .eq("inviter_user_id", link.owner_user_id)
    .eq("invitee_user_id", redeemerUserId)
    .in("status", ["pending", "accepted"])
    .maybeSingle();

  if (existingRedemption && existingInvite) {
    return { ok: true, kind: "manager", inviteId: String(existingInvite.id), alreadyRedeemed: true };
  }

  const ownershipOk = await verifyOwnershipStillHolds();
  if (!ownershipOk.ok) return ownershipOk;

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

  // Every failure below hands the use back rather than leaving a one-time link
  // spent on an invite that never existed.
  const spent = await spendUse();
  if (!spent.ok) return spent;

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
    return { ok: true, kind: "manager", inviteId: String(existingInvite.id), alreadyRedeemed: false };
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
  return { ok: true, kind: "manager", inviteId: String(invite.id), alreadyRedeemed: false };
}

export type ResidentInviteClaim = {
  id: string;
  linkId: string;
  linkLabel: string | null;
  claimantUserId: string;
  claimantEmail: string;
  claimantName: string | null;
  propertyId: string | null;
  roomId: string | null;
  note: string | null;
  status: "pending" | "approved" | "rejected";
  linkedApplicationId: string | null;
  createdAt: string;
};

const CLAIM_COLUMNS =
  "id, link_id, claimant_user_id, claimant_email, claimant_name, property_id, room_id, note, status, linked_application_id, created_at";

type DbClaimRow = {
  id: string;
  link_id: string;
  claimant_user_id: string;
  claimant_email: string;
  claimant_name: string | null;
  property_id: string | null;
  room_id: string | null;
  note: string | null;
  status: string;
  linked_application_id: string | null;
  created_at: string;
};

function normalizeClaimStatus(raw: unknown): ResidentInviteClaim["status"] {
  // Allowlist. An unrecognised status must read as the state that grants
  // nothing, never as `approved`.
  return raw === "approved" ? "approved" : raw === "rejected" ? "rejected" : "pending";
}

function toResidentInviteClaim(row: DbClaimRow, linkLabel: string | null): ResidentInviteClaim {
  return {
    id: String(row.id),
    linkId: String(row.link_id),
    linkLabel,
    claimantUserId: String(row.claimant_user_id),
    claimantEmail: String(row.claimant_email ?? ""),
    claimantName: row.claimant_name?.trim() || null,
    propertyId: row.property_id?.trim() || null,
    roomId: row.room_id?.trim() || null,
    note: row.note?.trim() || null,
    status: normalizeClaimStatus(row.status),
    linkedApplicationId: row.linked_application_id?.trim() || null,
    createdAt: row.created_at,
  };
}

/**
 * File a resident's claim on a property, and grant nothing.
 *
 * This is the whole difference between a resident link and a co-manager one. A
 * co-manager link produces an addressed invite that leads to real module
 * access; a resident link produces a row that says "this signed-in account
 * asserts it lives here" and stops. Everything downstream — which resident
 * record it belongs to, whether it is honoured at all — is the manager's
 * decision on a screen where they can see who is asking.
 *
 * The claim is NEVER auto-matched to an existing resident row by email. The
 * claimant's address is self-asserted from an account they created moments ago,
 * and matching it against `manager_application_records.resident_email` would
 * hand whoever holds the link that tenancy — its charges, its lease, its
 * documents. The manager picks the row.
 */
async function redeemResidentLink(args: {
  db: SupabaseClient;
  link: { id: string; owner_user_id: string; label?: string | null; assigned_property_ids: string[] | null; assigned_room_id?: string | null };
  redeemerUserId: string;
  alreadyRedeemed: boolean;
  verifyOwnershipStillHolds: () => Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  spendUse: () => Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  releaseSpentUse: () => Promise<void>;
}): Promise<RedeemInviteLinkResult> {
  const { db, link, redeemerUserId } = args;

  // Re-opening a link you already claimed shows you the claim you already have,
  // rather than filing a second one or spending another use.
  const { data: existingClaim } = await db
    .from("resident_invite_claims")
    .select("id")
    .eq("link_id", link.id)
    .eq("claimant_user_id", redeemerUserId)
    .maybeSingle();
  if (existingClaim) {
    return { ok: true, kind: "resident", claimId: String(existingClaim.id), alreadyRedeemed: true };
  }

  const ownershipOk = await args.verifyOwnershipStillHolds();
  if (!ownershipOk.ok) return ownershipOk;

  // The claimant's email comes from their AUTHENTICATED profile, never from a
  // request body — the whole point of requiring sign-in before redeeming is
  // that the address on the claim is one they actually control.
  const { data: claimant } = await db
    .from("profiles")
    .select("email, full_name")
    .eq("id", redeemerUserId)
    .maybeSingle();
  const claimantEmail = String(claimant?.email ?? "").trim().toLowerCase();
  if (!claimantEmail) {
    return {
      ok: false,
      status: 400,
      error: "Your account has no email address on it. Add one before claiming a home.",
    };
  }

  const spent = await args.spendUse();
  if (!spent.ok) return spent;

  const { error: redemptionError } = await db
    .from("manager_invite_link_redemptions")
    .insert({ link_id: link.id, redeemed_by_user_id: redeemerUserId });
  // A duplicate means a concurrent redeem by the same person — not a failure,
  // and the use we just spent is theirs either way.
  if (redemptionError && redemptionError.code !== "23505") {
    await args.releaseSpentUse();
    return { ok: false, status: 500, error: "Could not record this invite. Try again." };
  }
  const recordedRedemption = !args.alreadyRedeemed && !redemptionError;

  const { data: claim, error: claimError } = await db
    .from("resident_invite_claims")
    .insert({
      link_id: link.id,
      // From the LINK, never the claimant: they name neither the manager they
      // reach nor the property they land against.
      owner_user_id: link.owner_user_id,
      claimant_user_id: redeemerUserId,
      claimant_email: claimantEmail,
      claimant_name: String(claimant?.full_name ?? "").trim() || null,
      property_id: (link.assigned_property_ids ?? [])[0] ?? null,
      room_id: link.assigned_room_id?.trim() || null,
      status: "pending",
    })
    .select("id")
    .maybeSingle();

  if (claimError || !claim) {
    // A concurrent insert by the same person hit the unique index. Their claim
    // exists, so this is a success, not a failure — but the use must go back
    // because this attempt did not create it.
    if (claimError?.code === "23505") {
      await args.releaseSpentUse();
      const { data: raced } = await db
        .from("resident_invite_claims")
        .select("id")
        .eq("link_id", link.id)
        .eq("claimant_user_id", redeemerUserId)
        .maybeSingle();
      if (raced) {
        return { ok: true, kind: "resident", claimId: String(raced.id), alreadyRedeemed: true };
      }
    }
    if (recordedRedemption) {
      await db
        .from("manager_invite_link_redemptions")
        .delete()
        .eq("link_id", link.id)
        .eq("redeemed_by_user_id", redeemerUserId);
    }
    await args.releaseSpentUse();
    return { ok: false, status: 500, error: claimError?.message ?? "Could not record your claim." };
  }

  return { ok: true, kind: "resident", claimId: String(claim.id), alreadyRedeemed: false };
}

/** A manager's own pending claims. Scoped to the owner — an id is not authority. */
export async function listResidentInviteClaims(
  db: SupabaseClient,
  ownerUserId: string,
  status: ResidentInviteClaim["status"] = "pending",
): Promise<ResidentInviteClaim[]> {
  const { data } = await db
    .from("resident_invite_claims")
    .select(CLAIM_COLUMNS)
    .eq("owner_user_id", ownerUserId.trim())
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = (data ?? []) as DbClaimRow[];
  if (rows.length === 0) return [];

  const { data: links } = await db
    .from("manager_invite_links")
    .select("id, label")
    .in("id", [...new Set(rows.map((row) => String(row.link_id)))]);
  const labels = new Map(
    (links ?? []).map((row) => [String((row as { id: string }).id), (row as { label: string | null }).label]),
  );

  return rows.map((row) => toResidentInviteClaim(row, labels.get(String(row.link_id)) ?? null));
}

/**
 * Approve or dismiss a claim, scoped to the manager who owns it.
 *
 * Approving records WHICH resident record the manager attached the claim to.
 * That is the manager's judgement being written down, and it is the only thing
 * that ever connects a claimant to a tenancy — there is deliberately no path
 * where a claim finds its own resident record.
 */
export async function resolveResidentInviteClaim(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    claimId: string;
    status: "approved" | "rejected";
    linkedApplicationId?: string | null;
  },
): Promise<{ ok: true; claim: ResidentInviteClaim } | { ok: false; status: number; error: string }> {
  const linkedApplicationId = input.linkedApplicationId?.trim() ?? "";
  if (input.status === "approved" && !linkedApplicationId) {
    return {
      ok: false,
      status: 400,
      error: "Choose which resident this person is before approving their claim.",
    };
  }

  // The resident record id arrives in a REQUEST BODY, so it is a bound and not
  // an authorization — the same rule `POST /api/property-records` learned the
  // hard way. Without this check a manager could name any application id in the
  // system and rewrite a stranger's resident email to their claimant's below.
  // A missing row is treated as unowned.
  if (input.status === "approved") {
    const { data: owned, error: ownedError } = await db
      .from("manager_application_records")
      .select("id")
      .eq("id", linkedApplicationId)
      .eq("manager_user_id", input.ownerUserId.trim())
      .maybeSingle();
    // A FAILED lookup is a 500, never "not yours": falling through would refuse
    // a legitimate approval, and passing through would skip the check entirely.
    if (ownedError) {
      return { ok: false, status: 500, error: "Could not verify that resident. Try again in a moment." };
    }
    if (!owned) {
      return { ok: false, status: 403, error: "That resident is not one of yours." };
    }
  }

  const { data, error } = await db
    .from("resident_invite_claims")
    .update({
      status: input.status,
      linked_application_id: input.status === "approved" ? linkedApplicationId : null,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.claimId.trim())
    // Owner-scoped, and only a claim still awaiting a decision: re-resolving a
    // settled claim would silently overwrite a decision already acted on.
    .eq("owner_user_id", input.ownerUserId.trim())
    .eq("status", "pending")
    .select(CLAIM_COLUMNS)
    .maybeSingle();

  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return { ok: false, status: 404, error: "That request is no longer waiting for a decision." };

  const claim = toResidentInviteClaim(data as DbClaimRow, null);

  // NOTE: pointing the resident record at the claimant's email is deliberately
  // NOT done here.
  //
  // It was, and it silently did nothing. The manager's browser holds an
  // authoritative local copy of these application rows and mirrors them back
  // (`mirrorLocalPropertyPipelineToServer`), so a server-side write to
  // `resident_email` is overwritten by the next sync — verified against the dev
  // project, where the column reverted while `updated_at` advanced. Two writers,
  // and the server loses. The pairing therefore happens on the client, through
  // the same storage layer that owns the row, in `resident-invite-claims-panel`.
  //
  // What this function guarantees is the part that must be authoritative: the
  // manager owns the record they named, and the claim permanently records who
  // claimed what.
  return { ok: true, claim };
}
