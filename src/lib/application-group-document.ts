import {
  applicationGroupMemberStatusLabel,
  type ApplicationGroupMember,
  type GroupRole,
} from "@/lib/rental-application/application-groups";

function groupMemberRoleLabel(role: GroupRole | undefined): string {
  if (role === "first") return "Organizer";
  if (role === "joining") return "Joining member";
  return "";
}

/** One line per member for the application PDF/HTML roster section. */
export function formatApplicationGroupMemberLine(member: ApplicationGroupMember): string {
  const parts = [
    member.name,
    member.email,
    applicationGroupMemberStatusLabel(member.status),
    groupMemberRoleLabel(member.role),
  ].filter(Boolean);
  return parts.join(" · ");
}
