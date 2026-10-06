/**
 * The forms a manager has added, read from the same browser property store the send popup uses
 * (`resolveManagerListingSubmissionForPropertyId`). The sidebar Move-in page makes one tab per distinct
 * form name from this list, so a form gets its tab before anyone has been sent a copy.
 */
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import { readMoveInFormTemplates } from "@/lib/move-in-forms/templates";
import type { MoveInFormTemplate } from "@/lib/move-in-forms/types";
import { workspaceContainsProperty } from "@/lib/workspaces/selection";

/** Every named form on every property of the active workspace, each tagged with its property. */
export function managerPropertyMoveInForms(userId: string): Array<{ propertyId: string; template: MoveInFormTemplate }> {
  const out: Array<{ propertyId: string; template: MoveInFormTemplate }> = [];
  const seen = new Set<string>();
  for (const option of buildManagerPropertyFilterOptions(userId)) {
    if (!option.id || seen.has(option.id) || !workspaceContainsProperty(option.id)) continue;
    seen.add(option.id);
    const hit = resolveManagerListingSubmissionForPropertyId(userId, option.id);
    if (!hit) continue;
    for (const template of readMoveInFormTemplates(hit.sub)) {
      if (template.name.trim()) out.push({ propertyId: option.id, template });
    }
  }
  return out;
}
