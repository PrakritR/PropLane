export function shouldMountTourSettings(
  active: boolean,
  tab: string,
  propertyHubArea: string,
): boolean {
  return active && (tab === "tours" || (tab === "properties" && propertyHubArea === "tours"));
}
