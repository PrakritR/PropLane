/** Shared invite serialization; route modules export only handlers/configuration. */
import type { AccountLinkInviteDto } from "@/lib/account-links";
import { normalizePropertyCoManagerPermissions, flatCoManagerPermissionsFromProperty, type PropertyCoManagerPermissions } from "@/lib/co-manager-permissions";

export type InviteRow = {
  id: string;
  inviter_user_id: string;
  invitee_user_id: string | null;
  tab_kind: string;
  inviter_axis_id: string;
  invitee_axis_id: string | null;
  inviter_display_name: string | null;
  invitee_display_name: string | null;
  assigned_property_ids: unknown;
  payout_percent_for_manager: number;
  co_manager_permissions?: unknown;
  property_co_manager_permissions?: unknown;
  status: string;
  created_at: string;
  responded_at: string | null;
  expires_at?: string | null;
  invite_token_hash?: string | null;
  invitee_plan_inherited?: boolean;
};

export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string") as string[];
}

export function readPropertyPermissionsFromRow(
  row: Pick<InviteRow, "assigned_property_ids" | "property_co_manager_permissions" | "co_manager_permissions">,
): PropertyCoManagerPermissions {
  const assigned = asStringArray(row.assigned_property_ids);
  const raw = row.property_co_manager_permissions ?? row.co_manager_permissions;
  return normalizePropertyCoManagerPermissions(raw, assigned);
}

export function serializeInvite(
  row: InviteRow,
  viewerId: string,
  propertyLabelsById: Record<string, string> = {},
): AccountLinkInviteDto {
  const out = row.inviter_user_id === viewerId;
  const openInvite = !String(row.invitee_user_id ?? "").trim();
  const linkedAxisId = out ? (row.invitee_axis_id ?? "") : row.inviter_axis_id;
  const linkedDisplayName = out
    ? openInvite
      ? "Invite link"
      : row.invitee_display_name
    : row.inviter_display_name;
  const linkedUserId = out ? (row.invitee_user_id ?? "") : row.inviter_user_id;
  const assignedPropertyIds = asStringArray(row.assigned_property_ids);
  const propertyCoManagerPermissions = readPropertyPermissionsFromRow(row);
  const assignedPropertyLabels: Record<string, string> = {};
  for (const id of assignedPropertyIds) {
    const label = propertyLabelsById[id]?.trim();
    if (label) assignedPropertyLabels[id] = label;
  }
  return {
    id: row.id,
    tabKind: "manager",
    status:
      row.status === "accepted" ||
      row.status === "rejected" ||
      row.status === "cancelled" ||
      row.status === "pending"
        ? row.status
        : "pending",
    direction: out ? "outgoing" : "incoming",
    inviterAxisId: row.inviter_axis_id,
    inviteeAxisId: row.invitee_axis_id ?? "",
    openInvite,
    inviterDisplayName: row.inviter_display_name,
    inviteeDisplayName: row.invitee_display_name,
    linkedAxisId,
    linkedDisplayName,
    linkedUserId,
    assignedPropertyIds,
    assignedPropertyLabels: Object.keys(assignedPropertyLabels).length > 0 ? assignedPropertyLabels : undefined,
    payoutPercentForManager: Number(row.payout_percent_for_manager),
    coManagerPermissions: flatCoManagerPermissionsFromProperty(propertyCoManagerPermissions),
    propertyCoManagerPermissions,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
    expiresAt: row.expires_at ?? null,
  };
}
