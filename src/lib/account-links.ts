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
  /** For the signed-in user: the other workspace’s Axis ID and label. */
  linkedAxisId: string;
  linkedDisplayName: string | null;
  /** The other workspace's auth user id (for ownership transfer, etc.). */
  linkedUserId: string;
  assignedPropertyIds: string[];
  /** Resolved from `manager_property_records` when the invite payload is loaded. */
  assignedPropertyLabels?: Record<string, string>;
  payoutPercentForManager: number;
  /** Merged flat permissions across all assigned properties (nav gating). */
  coManagerPermissions: CoManagerPermissions;
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
