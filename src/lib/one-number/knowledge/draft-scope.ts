/** A teammate (`allowed` set) may act only on a draft about a house they hold; the owner (null) on any. */
export function draftHouseAllowed(propertyId: string | null | undefined, allowed: readonly string[] | null | undefined): boolean {
  if (!allowed) return true;
  const id = String(propertyId ?? "").trim();
  return id !== "" && allowed.includes(id);
}
