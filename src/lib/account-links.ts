/** Shared types for `/api/pro/account-links` (server + client). */

import type { CoManagerPermissions, PropertyCoManagerPermissions } from "@/lib/co-manager-permissions";

/** @deprecated Owner tab removed — only manager co-manager links are supported. */
export type AccountLinkTabKind = "manager";

export type AccountLinkInviteStatus = "pending" | "accepted" | "rejected" | "cancelled";

export type AccountLinkInviteDto = {
  id: string;
  tabKind: AccountLinkTabKind;
  status: AccountLinkInviteStatus;
  direction: "outgoing" | "incoming";
  inviterAxisId: string;
  inviteeAxisId: string;
  inviterDisplayName: string | null;
  inviteeDisplayName: string | null;
  /**
   * Pending shareable link that nobody has claimed yet (`invitee_user_id` is
   * null). The list row is "Invite link" until she joins.
   */
  openInvite?: boolean;
  /** For the signed-in user: the other workspace’s Axis ID and label. */
  linkedAxisId: string;
  linkedDisplayName: string | null;
  /** The other workspace's auth user id (for ownership transfer, etc.). */
  linkedUserId: string;
  /** Resolved from `profiles` when the invite list is loaded. */
  linkedEmail?: string | null;
  linkedPhone?: string | null;
  assignedPropertyIds: string[];
  /** Resolved from `manager_property_records` when the invite payload is loaded. */
  assignedPropertyLabels?: Record<string, string>;
  payoutPercentForManager: number;
  /** Merged flat permissions across all assigned properties (nav gating). */
  coManagerPermissions: CoManagerPermissions;
  /**
   * When the invite stops being acceptable (30 days from creation).
   *
   * A pending invite used to live forever, and one that was never delivered was
   * also never chased — a stale, invisible, maximum-lifetime grant (PRP-205).
   * Null only on a row written before the column existed.
   */
  expiresAt?: string | null;
  /** Per-property permission grants. */
  propertyCoManagerPermissions: PropertyCoManagerPermissions;
  createdAt: string;
  respondedAt: string | null;
};

export type AccountLinksPayload = {
  migrationRequired?: boolean;
  invites: AccountLinkInviteDto[];
};

export function looksLikeAccountLinksMissingTable(err: { message?: string } | null | undefined): boolean {
  const m = (err?.message ?? "").toLowerCase();
  return (
    m.includes("account_link_invites") &&
    (m.includes("does not exist") || m.includes("schema cache") || m.includes("relation"))
  );
}
