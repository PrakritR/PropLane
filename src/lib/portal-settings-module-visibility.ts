export function shouldMountTourSettings(
  active: boolean,
  tab: string,
): boolean {
  return active && tab === "tours";
}
