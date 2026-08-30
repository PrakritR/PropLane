import type { AccountLinkInviteDto } from "@/lib/account-links";
import {
  type CoManagerPermissions,
  mergeCoManagerPermissionsFromPropertyRows,
} from "@/lib/co-manager-permissions";

export type ManagerNavRole = {
  isPrimaryManager: boolean;
  mergedPermissions: CoManagerPermissions;
  /**
   * True when the user is a co-manager with ≥1 accepted incoming link but no
   * explicit module restrictions (merged permissions empty). Retained for
   * callers that branch on the data-layer empty-permissions = full-access rule.
   */
  hasEmptyPermissionCoManagerLink: boolean;
};

/**
 * Derive portal nav role from accepted account-link invite directions.
 *
 * `ownsProperties` must be true when the user has their OWN portfolio. An owner
 * who is ALSO a co-manager for someone else's properties is still a PRIMARY
 * manager for nav purposes — they see every section (their own properties grant
 * full access); the per-property co-manager grants only restrict access to the
 * LINKED properties at the data layer, never the user's own nav. Without this a
 * property-owning manager who received an incoming link would lose nav sections
 * (e.g. Applications) that their own properties require.
 */
export function deriveManagerNavRole(
  invites: Pick<AccountLinkInviteDto, "direction" | "status" | "coManagerPermissions" | "propertyCoManagerPermissions">[],
  ownsProperties = false,
): ManagerNavRole {
  const accepted = invites.filter((inv) => inv.status === "accepted");
  const hasOutgoing = accepted.some((inv) => inv.direction === "outgoing");
  const incoming = accepted.filter((inv) => inv.direction === "incoming");

  const isPrimaryManager = hasOutgoing || ownsProperties || incoming.length === 0;
  const mergedPermissions = isPrimaryManager
    ? {}
    : mergeCoManagerPermissionsFromPropertyRows(
        incoming.map((inv) => ({
          propertyCoManagerPermissions: inv.propertyCoManagerPermissions,
          coManagerPermissions: inv.coManagerPermissions,
        })),
      );

  // A co-manager reaches this branch only with ≥1 accepted incoming link
  // (isPrimaryManager is true when there are none). If the merged set is empty,
  // nothing was explicitly restricted, so default to full module nav.
  const hasEmptyPermissionCoManagerLink =
    !isPrimaryManager && Object.keys(mergedPermissions).length === 0;

  return { isPrimaryManager, mergedPermissions, hasEmptyPermissionCoManagerLink };
}
