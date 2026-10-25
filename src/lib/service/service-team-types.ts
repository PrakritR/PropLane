import type { CoManagerPermissions, PropertyCoManagerPermissions } from "@/lib/co-manager-permissions";
import type { WorkspaceCoManagerGrant } from "@/lib/workspace-co-manager-permissions";
import type { HouseScope } from "@/lib/workspaces/membership";

/** One row of a PropLane Service workspace's Team, as `POST /api/admin/service-workspaces` `team` returns it. */
export type ServiceTeamMember = {
  /** The membership id; for `delivery: "link"` the invite link's id (the Remove verb takes `inviteLinkId` for it). */
  linkId: string;
  userId: string;
  name: string;
  /** Empty for a pending invite: the invitee has not consented to disclose it yet. A link invite shows the email it was sent to. */
  email: string;
  role: string;
  status: "accepted" | "pending";
  ownerOfRecord: boolean;
  /** "account": a membership row. "link": an unspent invite link for someone with no account yet (nothing to edit until they accept). */
  delivery: "account" | "link";
  /** What Edit access prefills. Absent for a link invite. */
  houseScope?: HouseScope;
  assignedPropertyIds?: string[];
  propertyCoManagerPermissions?: PropertyCoManagerPermissions;
  coManagerPermissions?: CoManagerPermissions;
  workspacePermissions?: WorkspaceCoManagerGrant;
};
