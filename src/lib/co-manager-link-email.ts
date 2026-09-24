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
  void inviteId;
  return portalTeamSettingsUrl();
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
