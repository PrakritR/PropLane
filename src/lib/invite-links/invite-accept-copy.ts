import type { InviteLinkKind } from "@/lib/invite-links/invite-link-model";

export function firstNameFromDisplay(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "them";
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

export function inviteAcceptTitle(kind: InviteLinkKind): string {
  if (kind === "vendor") return "Invite to vendor directory";
  if (kind === "resident") return "Invite to your home";
  return "Invite to workspace";
}

export function inviteAcceptSubtitle(input: {
  kind: InviteLinkKind;
  ownerName: string;
  workspaceName?: string | null;
}): string {
  const owner = input.ownerName.trim() || "A property manager";
  if (input.kind === "vendor") {
    return `${owner} invited you to join their vendor directory on PropLane.`;
  }
  if (input.kind === "resident") {
    return `${owner} invited you to confirm you live here on PropLane.`;
  }
  const workspace = input.workspaceName?.trim();
  return workspace
    ? `${owner} invited you to ${workspace} on PropLane.`
    : `${owner} invited you to their workspace on PropLane.`;
}
