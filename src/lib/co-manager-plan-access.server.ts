import { managerPlanAllowsCoManagerInvites as managerPlanAllowsCoManagerInvitesShared } from "@/lib/manager-access";

/** Co-manager invites require a paid SKU (Pro/Business), including signup trial. */
export function managerPlanAllowsCoManagerInvites(input: {
  tier: string | null | undefined;
}): boolean {
  return managerPlanAllowsCoManagerInvitesShared(input.tier);
}
