/**
 * The words PropLane sends when someone is added to, changed on, or removed from a PropLane-managed workspace's staff:
 * one email and at most one text per event. Pure (no I/O) so the senders, the tests and `scripts/practice-notices.mts` all
 * render the same copy. Plain words, no long dashes, no filler line under a sentence.
 *
 * The seat INVITE email is `buildAdminInviteBody` (co-manager-link-email.ts); this file adds its text and the two notices
 * an existing account gets when a seat is granted or revoked.
 */
import { ADMIN_INVITE_EXPIRY_DAYS } from "@/lib/admin-team/admin-team-model";

function workspaceList(names: readonly string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return "PropLane";
  if (clean.length === 1) return clean[0]!;
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

/** The text that goes with the invite email. It carries the same one-use, email-bound link and nothing else. */
export function buildAdminInviteText(params: { inviterName: string; roleLabel: string; workspaceNames: readonly string[]; acceptUrl: string }): string {
  const inviter = params.inviterName.trim() || "A PropLane admin";
  const scope = params.workspaceNames.map((n) => n.trim()).filter(Boolean);
  const what = scope.length > 0 ? `help manage ${workspaceList(scope)}` : `join PropLane admin as ${params.roleLabel}`;
  return `PropLane: ${inviter} invited you to ${what}. Accept within ${ADMIN_INVITE_EXPIRY_DAYS} days: ${params.acceptUrl}`;
}

/** An existing account was given a seat on one or more managed workspaces (or its access was changed). */
export function seatGrantedSubject(workspaceNames: readonly string[]): string {
  return `You now help manage ${workspaceList(workspaceNames)}`;
}

export function buildSeatGrantedBody(params: { inviterName: string; roleLabel: string; workspaceNames: readonly string[]; openUrl: string }): string {
  const inviter = params.inviterName.trim() || "A PropLane admin";
  return [
    "Hi,",
    "",
    `${inviter} gave you ${params.roleLabel} access to ${workspaceList(params.workspaceNames)} on PropLane. You get alerts for the houses you cover.`,
    "",
    `Open it from your account menu: ${params.openUrl}`,
    "",
    "PropLane",
  ].join("\n");
}

export function buildSeatGrantedText(params: { workspaceNames: readonly string[]; openUrl: string }): string {
  return `PropLane: you now help manage ${workspaceList(params.workspaceNames)}. Open it: ${params.openUrl}`;
}

/** A seat was removed: access and alerts for those workspaces stop; the person's own account is untouched. */
export function seatRevokedSubject(workspaceNames: readonly string[]): string {
  return `Your access to ${workspaceList(workspaceNames)} was removed`;
}

export function buildSeatRevokedBody(params: { workspaceNames: readonly string[] }): string {
  return [
    "Hi,",
    "",
    `Your access to ${workspaceList(params.workspaceNames)} on PropLane was removed. You will no longer get alerts for ${params.workspaceNames.filter((n) => n.trim()).length > 1 ? "them" : "it"}.`,
    "",
    "Your own PropLane account and its workspaces are unchanged.",
    "",
    "PropLane",
  ].join("\n");
}

export function buildSeatRevokedText(params: { workspaceNames: readonly string[] }): string {
  return `PropLane: your access to ${workspaceList(params.workspaceNames)} was removed. Alerts have stopped.`;
}
