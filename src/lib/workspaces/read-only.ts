import type { PortalWorkspace } from "@/lib/workspaces/types";

/**
 * View-only workspaces (PropLane Service manages them for their owner). The server derives
 * `PortalWorkspace.readOnly` (`managedReadOnlyFor`) and refuses the writes in the middleware and the tool layer; this
 * module is the UI half: one place that decides what a read-only viewer is shown.
 */

/** `data-read-only` value stamped on the portal root while the active workspace is view-only. */
export const READ_ONLY_ATTRIBUTE = "data-read-only";
export const READ_ONLY_MANAGED = "managed";

export function isWorkspaceReadOnly(workspace: Pick<PortalWorkspace, "readOnly"> | null | undefined): boolean {
  return workspace?.readOnly === true;
}

/**
 * A ⋯ menu entry that changes data: dropped for a view-only viewer. A denylist on purpose: the same menu component
 * also draws Sign out, the workspace switcher and the profile menu, which must keep every entry. The server refuses
 * a write the list misses, so a missed verb is a visible button that does nothing, never a write.
 */
const WRITE_MENU_LABEL =
  /^\s*(edit|delete|remove|archive|unarchive|restore|add|new|create|assign|unassign|rename|duplicate|merge|move|set|reset|send|resend|approve|decline|reject|deny|cancel|reschedule|schedule|invite|publish|unpublish|pause|resume|close|reopen|void|refund|import|upload|save|change|update|transfer|link|unlink|disconnect|connect|enable|disable|activate|deactivate|block|unblock|escalate|charge|pay|withdraw|renew|terminate|evict|waive|credit)\b/i;

export function readOnlyMenuLabelAllowed(label: string): boolean {
  return !WRITE_MENU_LABEL.test(label.trim());
}

/** Header icon actions (record pages, list bands) that change data: hidden for a view-only viewer. */
const WRITE_ICON_LABEL = /^\s*(edit|delete|remove|archive|unarchive|restore|add|new|create|upload|invite|assign|rename|import|duplicate|merge|reorder)\b/i;

export function isWriteActionLabel(label: string): boolean {
  return WRITE_ICON_LABEL.test(label);
}
