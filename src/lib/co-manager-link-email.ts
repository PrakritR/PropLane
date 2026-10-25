/**
 * Client-safe co-manager link message copy (invite + removal).
 * Server notification helpers should stay aligned with these builders.
 */

import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { MANAGER_TEAM_SETTINGS_PATH } from "@/lib/portals/manager-plan-path";

function portalTeamSettingsUrl(): string {
  return `${resolveEmailLinkBaseUrl()}${MANAGER_TEAM_SETTINGS_PATH}`;
}

/** Deep link after invite: Settings → Workspaces (pending invites live there). */
export function coManagerInviteAcceptUrl(inviteId: string): string {
  const id = inviteId.trim();
  if (!id) return portalTeamSettingsUrl();
  return `${portalTeamSettingsUrl()}&acceptInvite=${encodeURIComponent(id)}`;
}

export function coManagerInviteSubject(inviterName: string): string {
  const name = inviterName.trim() || "A property manager";
  return `${name} invited you as a co-manager`;
}

export function buildCoManagerInviteBody(params: {
  inviterName: string;
  propertyLabels: string[];
  inviteId?: string;
}): string {
  const inviterName = params.inviterName.trim() || "A property manager";
  const properties =
    params.propertyLabels.length > 0 ? params.propertyLabels.join(", ") : "assigned properties";
  const acceptUrl = params.inviteId?.trim()
    ? coManagerInviteAcceptUrl(params.inviteId)
    : portalTeamSettingsUrl();
  return [
    `${inviterName} invited you to co-manage properties on PropLane.`,
    "",
    `Properties: ${properties}`,
    "",
    `Accept the invite: ${acceptUrl}`,
    "",
    "— PropLane",
  ].join("\n");
}

/**
 * PropLane Service: the owner of a workspace PropLane manages for them is not invited to "co-manage"; they are told
 * PropLane has set the workspace up and asked to create their account. Plain words, no long dashes. The accept link is
 * the same one a teammate gets (Settings > Workspaces for an account that exists, the invite page for one that does
 * not).
 */
export function ownerInviteSubject(workspaceName: string): string {
  const name = workspaceName.trim() || "your workspace";
  return `PropLane manages ${name} for you`;
}

function firstNameOf(raw: string | null | undefined): string {
  const first = String(raw ?? "").trim().split(/\s+/)[0] ?? "";
  // An email address is not a name: "Hi owner@example.com," reads as a form letter.
  return first && !first.includes("@") ? first : "there";
}

export function buildOwnerInviteBody(params: { ownerName?: string | null; workspaceName: string; acceptUrl: string }): string {
  const name = params.workspaceName.trim() || "your workspace";
  return [
    `Hi ${firstNameOf(params.ownerName)},`,
    "",
    `PropLane has set up ${name} for your homes. Create your account to see rent, payouts and services: ${params.acceptUrl}`,
    "",
    "PropLane",
  ].join("\n");
}

export function buildOwnerInviteText(params: { workspaceName: string; acceptUrl: string }): string {
  const name = params.workspaceName.trim() || "Your workspace";
  return `PropLane: ${name} is ready. Create your account to see your homes: ${params.acceptUrl}`;
}

/** A teammate invited to a PropLane Service workspace by link (they have no account yet). */
export function serviceTeamInviteSubject(workspaceName: string): string {
  return `Join ${workspaceName.trim() || "a PropLane workspace"} on PropLane`;
}

export function buildServiceTeamInviteBody(params: { workspaceName: string; roleLabel: string; acceptUrl: string }): string {
  const name = params.workspaceName.trim() || "a PropLane workspace";
  return [
    "Hi,",
    "",
    `PropLane invited you to ${name} as ${params.roleLabel}. Create your account or sign in to accept: ${params.acceptUrl}`,
    "",
    "PropLane",
  ].join("\n");
}

export function coManagerLinkRemovedSubject(actorName: string): string {
  const name = actorName.trim() || "A property manager";
  return `Co-manager link update from ${name}`;
}

export function buildCoManagerLinkRemovedBody(params: {
  actorName: string;
  propertyLabels?: string[];
}): string {
  const actorName = params.actorName.trim() || "A property manager";
  const properties = params.propertyLabels?.filter(Boolean);
  const propertyLine =
    properties && properties.length > 0
      ? `Properties affected: ${properties.join(", ")}`
      : "Your co-manager access on PropLane was updated.";
  return [
    `${actorName} disconnected you from their team on PropLane.`,
    "",
    propertyLine,
    "",
    `Open your portal: ${portalTeamSettingsUrl()}`,
    "",
    "— PropLane",
  ].join("\n");
}

export function coManagerInviteWithdrawnSubject(actorName: string): string {
  const name = actorName.trim() || "A property manager";
  return `Co-manager invite withdrawn by ${name}`;
}

export function buildCoManagerInviteWithdrawnBody(params: { actorName: string }): string {
  const actorName = params.actorName.trim() || "A property manager";
  return [
    `${actorName} withdrew their co-manager invite on PropLane.`,
    "",
    "No action is required unless they send a new invite.",
    "",
    "— PropLane",
  ].join("\n");
}

export function coManagerInviteDeclinedSubject(inviteeName: string): string {
  const name = inviteeName.trim() || "A co-manager";
  return `${name} declined your co-manager invite`;
}

export function buildCoManagerInviteDeclinedBody(params: { inviteeName: string }): string {
  const inviteeName = params.inviteeName.trim() || "A co-manager";
  return [
    `${inviteeName} declined your co-manager invite on PropLane.`,
    "",
    "You can send a new invite from Co-managers when you are ready.",
    "",
    `Open your portal: ${portalTeamSettingsUrl()}`,
    "",
    "— PropLane",
  ].join("\n");
}

export function coManagerLinkLeftSubject(inviteeName: string): string {
  const name = inviteeName.trim() || "A co-manager";
  return `${name} left your co-manager team`;
}

export function buildCoManagerLinkLeftBody(params: {
  inviteeName: string;
  propertyLabels?: string[];
}): string {
  const inviteeName = params.inviteeName.trim() || "A co-manager";
  const properties = params.propertyLabels?.filter(Boolean);
  const propertyLine =
    properties && properties.length > 0
      ? `Properties affected: ${properties.join(", ")}`
      : "Their co-manager access on PropLane was removed.";
  return [
    `${inviteeName} left your co-manager team on PropLane.`,
    "",
    propertyLine,
    "",
    `Manage your team: ${portalTeamSettingsUrl()}`,
    "",
    "— PropLane",
  ].join("\n");
}
