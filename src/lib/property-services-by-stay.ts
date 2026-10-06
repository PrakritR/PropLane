/**
 * The property Services page = the services OFFERED at this property (`serviceRequestOptions`), under
 * Long term / Short term tabs. A service with no `appliesTo` is for both stays and shows in both tabs
 * (`property-stay-tabs.ts` is the one rule). Requests live on the main Services page, not here.
 *
 * Pure.
 */
import {
  createManagerListingServiceOption,
  type ManagerListingServiceOption,
  type ServiceBillingCadence,
} from "@/lib/manager-listing-submission";
import { rowsInStay, type PropertyStay, type StayAppliesTo } from "@/lib/property-stay-tabs";

/** Quick add presets on the property Services page. `both`: the service is natural for either stay. */
export const PROPERTY_SERVICE_QUICK_ADDS: ReadonlyArray<{
  key: string;
  label: string;
  billingCadence: ServiceBillingCadence;
  both: boolean;
}> = [
  { key: "cleaning", label: "Cleaning", billingCadence: "per_request", both: true },
  { key: "linen-change", label: "Linen change", billingCadence: "per_request", both: false },
  { key: "parking-spot", label: "Parking spot", billingCadence: "monthly", both: false },
  { key: "storage", label: "Storage", billingCadence: "monthly", both: false },
  { key: "early-check-in", label: "Early check-in", billingCadence: "one_time", both: false },
  { key: "late-checkout", label: "Late checkout", billingCadence: "one_time", both: false },
  { key: "furnishing", label: "Furnishing", billingCadence: "one_time", both: true },
];

/**
 * The presets this property does not already offer (matched on name, any case). With a `stay` (the open
 * Long term / Short term tab) only the services that tab lists count as offered - Quick add adds to the tab
 * you are on, so a long-term-only service never hides the preset from the Short term tab.
 */
export function missingServiceQuickAdds(
  offers: readonly ManagerListingServiceOption[],
  stay?: PropertyStay,
): { key: string; label: string }[] {
  const inTab = stay ? rowsInStay(offers, stay, serviceAppliesTo) : offers;
  const have = new Set(inTab.map((offer) => offer.name.trim().toLowerCase()));
  return PROPERTY_SERVICE_QUICK_ADDS.filter((preset) => !have.has(preset.label.toLowerCase())).map(({ key, label }) => ({
    key,
    label,
  }));
}

/** A new service from a preset: for both stays where natural, else for the stay of the open tab. */
export function serviceFromQuickAdd(key: string, tab: PropertyStay): ManagerListingServiceOption | null {
  const preset = PROPERTY_SERVICE_QUICK_ADDS.find((p) => p.key === key);
  if (!preset) return null;
  const appliesTo: StayAppliesTo = preset.both ? "both" : tab;
  return { ...createManagerListingServiceOption(preset.label), billingCadence: preset.billingCadence, appliesTo };
}

/** What a service applies to; absent reads as both. */
export function serviceAppliesTo(offer: Pick<ManagerListingServiceOption, "appliesTo">): StayAppliesTo {
  return offer.appliesTo ?? "both";
}
