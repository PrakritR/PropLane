import type { AccountLinkInviteDto } from "@/lib/account-links";
import {
  type CoManagerPermissions,
  mergeCoManagerPermissionsFromPropertyRows,
} from "@/lib/co-manager-permissions";

export type ManagerNavRole = {
  isPrimaryManager: boolean;
  mergedPermissions: CoManagerPermissions;
  /**
   * True when the user is a co-manager with ≥1 accepted incoming link whose
   * merged permissions are empty. That state now confers NO module access
   * (PRP-199), and nav no longer locks sections on it — the flag is retained
   * only for callers and tests that still read it.
   */
  hasEmptyPermissionCoManagerLink: boolean;
};

/**
 * Derive portal nav role from accepted account-link invite directions.
 *
 * `ownsProperties` must be true when the user has their OWN portfolio. An owner
 * who is ALSO a co-manager for someone else's properties is still a PRIMARY
 * manager for nav purposes — they see every section (their own properties grant
 * full access); the per-property co-manager grants decide what they reach on the
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
  // (isPrimaryManager is true when there are none). An empty merged set means
  // nothing was granted, not that nothing was restricted.
  const hasEmptyPermissionCoManagerLink =
    !isPrimaryManager && Object.keys(mergedPermissions).length === 0;

  return { isPrimaryManager, mergedPermissions, hasEmptyPermissionCoManagerLink };
}
