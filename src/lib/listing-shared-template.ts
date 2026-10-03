/** Listing-share copy, shared by Settings, preview and delivery. */
export const LISTING_SHARED_TEMPLATE_KEY = "listing:shared:resident";
export const DEFAULT_LISTING_SHARED_INTRO = "Your property manager shared {homes} with you on PropLane.";

export function renderListingSharedIntro(template: string, input: { count: number; property: string; name?: string }): string {
  const values: Record<string, string> = {
    homes: input.count > 1 ? `${input.count} homes` : input.property || "a home",
    property: input.property,
    first_name: input.name?.trim().split(/\s+/)[0] || "there",
  };
  return template.replace(/\{(homes|property|first_name)\}/g, (_, key: string) => values[key]);
}
