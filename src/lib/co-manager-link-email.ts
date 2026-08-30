/**
 * Client-safe co-manager link message copy (invite + removal).
 * Server notification helpers should stay aligned with these builders.
 */

import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

function portalRelationshipsUrl(): string {
  return `${resolveEmailLinkBaseUrl()}/portal/relationships`;
}

export function coManagerInviteSubject(inviterName: string): string {
  const name = inviterName.trim() || "A property manager";
  return `${name} invited you as a co-manager`;
}

export function buildCoManagerInviteBody(params: {
  inviterName: string;
  propertyLabels: string[];
}): string {
  const inviterName = params.inviterName.trim() || "A property manager";
  const properties =
    params.propertyLabels.length > 0 ? params.propertyLabels.join(", ") : "assigned properties";
  return [
    `${inviterName} invited you to co-manage properties on PropLane.`,
    "",
    `Properties: ${properties}`,
    "",
    `Open your portal to review and approve the link: ${portalRelationshipsUrl()}`,
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
    `${actorName} removed your co-manager link on PropLane.`,
    "",
    propertyLine,
    "",
    `Open your portal: ${portalRelationshipsUrl()}`,
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
    `Open your portal: ${portalRelationshipsUrl()}`,
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
    `Manage your team: ${portalRelationshipsUrl()}`,
    "",
    "— PropLane",
  ].join("\n");
}
