/**
 * Which stay (Long term / Short term) a move-in form belongs to, for the property's Long-term forms and
 * Short-term forms tabs. Pure; no stored field. A form's stay is its "Applies to":
 *
 * - `leaseType` absent / "all" -> BOTH stays (the same record in both tabs).
 * - `leaseType` "long-term" / "short-term" -> that stay (`templateLeaseTypeAdmits` is the one rule).
 * - Linked to specific leases (`linkedLeaseTemplateIds`) -> the stay those leases share; when they differ, or none
 *   of them still exists, both stays. Nothing is ever dropped from the tabs.
 */
import { templateLeaseTypeAdmits } from "@/lib/move-in-forms/templates";
import type { MoveInFormTemplate } from "@/lib/move-in-forms/types";
import { PROPERTY_STAYS, stayCounts, stayTabsFor, type PropertyStay, type StayAppliesTo } from "@/lib/property-stay-tabs";

type FormStayShape = Pick<MoveInFormTemplate, "leaseType" | "linkedLeaseTemplateIds">;
/** A lease of the property: its template kind decides its stay (a short-term lease is short; every other kind is long). */
export type MoveInStayLease = { id: string; kind: string };

function leaseStay(lease: MoveInStayLease): PropertyStay {
  return lease.kind === "short-term" ? "short_term" : "long_term";
}

/** The stays a form shows under, in tab order. Never empty. */
export function moveInFormStays(template: FormStayShape, leases: readonly MoveInStayLease[] = []): PropertyStay[] {
  const linked = (template.linkedLeaseTemplateIds ?? [])
    .map((id) => leases.find((lease) => lease.id === id))
    .filter((lease): lease is MoveInStayLease => Boolean(lease))
    .map(leaseStay);
  if (linked.length > 0) {
    const first = linked[0]!;
    return linked.every((stay) => stay === first) ? [first] : [...PROPERTY_STAYS];
  }
  if ((template.linkedLeaseTemplateIds ?? []).length === 0) {
    const admitted = PROPERTY_STAYS.filter((stay) =>
      templateLeaseTypeAdmits(template, stay === "long_term" ? "long-term" : "short-term"),
    );
    if (admitted.length > 0) return admitted;
  }
  return [...PROPERTY_STAYS];
}

/** The same answer as `StayAppliesTo`, for `stayCounts` / `rowsInStay`. */
export function moveInFormAppliesTo(template: FormStayShape, leases: readonly MoveInStayLease[] = []): StayAppliesTo {
  const stays = moveInFormStays(template, leases);
  return stays.length === 1 ? stays[0]! : "both";
}

/** The `leaseType` a form added from the open stay's tab is created with (Quick add and the round +). */
export function moveInFormLeaseTypeForStay(stay: PropertyStay): "long-term" | "short-term" {
  return stay === "short_term" ? "short-term" : "long-term";
}

/** The forms that show in `stay`'s tab (both-stay forms are in each). */
export function moveInFormsInStay<T extends FormStayShape>(
  templates: readonly T[],
  stay: PropertyStay,
  leases: readonly MoveInStayLease[] = [],
): T[] {
  return templates.filter((template) => moveInFormStays(template, leases).includes(stay));
}

/**
 * A form created from the open tab (Quick add, the round +) starts as that stay's form: its "Applies to" is the
 * stay. A form already tied to specific leases keeps them.
 */
export function moveInFormForStay<T extends FormStayShape>(template: T, stay: PropertyStay): T {
  if ((template.linkedLeaseTemplateIds ?? []).length > 0) return template;
  return { ...template, leaseType: moveInFormLeaseTypeForStay(stay) };
}

/**
 * The Long-term forms / Short-term forms tabs of a property: each tab's count (a form for both is counted in both)
 * and which tabs exist. A stay the property does not allow keeps its tab only when a form is for THAT stay alone; a
 * form for both never holds a disallowed tab open (the default Move-in checklist is for both).
 */
export function moveInFormStayTabs(
  sub: Parameters<typeof stayTabsFor>[0],
  templates: readonly FormStayShape[],
  leases: readonly MoveInStayLease[] = [],
): { tabs: PropertyStay[]; counts: Record<PropertyStay, number> } {
  const appliesTo = (template: FormStayShape) => moveInFormAppliesTo(template, leases);
  const counts = stayCounts(templates, appliesTo);
  const only = PROPERTY_STAYS.filter((stay) => templates.some((template) => appliesTo(template) === stay));
  return { tabs: stayTabsFor(sub, only), counts };
}
