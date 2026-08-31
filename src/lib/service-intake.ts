import type { ManagerListingServiceOption } from "@/lib/manager-listing-submission";
import { CUSTOM_SERVICE_REQUEST_OFFER_ID } from "@/lib/service-requests-storage";
import {
  type ResidentMaintenanceCategoryLabel,
  workOrderCategoryForResidentLabel,
} from "@/lib/work-order-taxonomy";

/** Repair categories shown in the unified service picker (lights, toilet, HVAC, etc.). */
export const RESIDENT_SERVICE_REPAIR_CATEGORIES: readonly ResidentMaintenanceCategoryLabel[] = [
  "Plumbing",
  "Electrical",
  "HVAC",
  "Appliance",
  "Access / Locks",
  "General",
] as const;

export const SERVICE_INTAKE_PRIORITY_OPTIONS = ["Emergency", "High", "Medium", "Low"] as const;
export type ServiceIntakePriority = (typeof SERVICE_INTAKE_PRIORITY_OPTIONS)[number];

export type ServiceIntakeKind = "add-on" | "repair";

export type ServiceIntakeOption = {
  key: string;
  label: string;
  kind: ServiceIntakeKind;
  /** `<optgroup>` label in the service-type select. */
  group: "property" | "repair" | "other";
  offerId?: string;
  categoryLabel?: ResidentMaintenanceCategoryLabel;
  isCustomAddOn?: boolean;
};

export function buildServiceIntakeOptions(
  catalogOffers: readonly ManagerListingServiceOption[],
): ServiceIntakeOption[] {
  const options: ServiceIntakeOption[] = [];

  for (const offer of catalogOffers) {
    const name = offer.name?.trim();
    if (!name) continue;
    options.push({
      key: `addon:${offer.id}`,
      label: offer.price?.trim() ? `${name} · ${offer.price.trim()}` : name,
      kind: "add-on",
      group: "property",
      offerId: offer.id,
    });
  }

  for (const category of RESIDENT_SERVICE_REPAIR_CATEGORIES) {
    options.push({
      key: `repair:${category}`,
      label: category,
      kind: "repair",
      group: "repair",
      categoryLabel: category,
    });
  }

  options.push({
    key: "addon:custom",
    label: "Custom add-on request",
    kind: "add-on",
    group: "other",
    isCustomAddOn: true,
  });

  return options;
}

export function findServiceIntakeOption(
  options: readonly ServiceIntakeOption[],
  key: string,
): ServiceIntakeOption | null {
  return options.find((option) => option.key === key) ?? null;
}

export function defaultServiceIntakeOptionKey(options: readonly ServiceIntakeOption[]): string {
  return options[0]?.key ?? "repair:General";
}

export function serviceIntakeIsCustomAddOn(option: ServiceIntakeOption | null): boolean {
  return Boolean(option?.isCustomAddOn || option?.offerId === CUSTOM_SERVICE_REQUEST_OFFER_ID);
}

export function serviceIntakeCategoryForOption(
  option: ServiceIntakeOption | null,
  categoryLabel: ResidentMaintenanceCategoryLabel,
) {
  if (option?.categoryLabel) return workOrderCategoryForResidentLabel(option.categoryLabel);
  return workOrderCategoryForResidentLabel(categoryLabel);
}

export function serviceIntakeSuggestedTitle(
  option: ServiceIntakeOption | null,
  categoryLabel: ResidentMaintenanceCategoryLabel,
): string {
  if (!option) return "";
  if (option.kind === "repair") {
    switch (option.categoryLabel ?? categoryLabel) {
      case "Plumbing":
        return "Plumbing issue";
      case "Electrical":
        return "Lighting or electrical issue";
      case "HVAC":
        return "Heating or cooling issue";
      case "Appliance":
        return "Appliance issue";
      case "Access / Locks":
        return "Access or lock issue";
      default:
        return "Service request";
    }
  }
  return "";
}
