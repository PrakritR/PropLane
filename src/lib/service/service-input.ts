/** Client-safe input rules for PropLane Service workspaces; the server re-applies them (`service-workspaces.server.ts`). */

export function cleanServiceName(raw: unknown): string | null {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  return name.length >= 1 && name.length <= 80 ? name : null;
}

/** City is optional; an unusable value (too long, not text) is `undefined`, a blank one is `null`. */
export function cleanServiceCity(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const city = raw.trim().replace(/\s+/g, " ");
  if (!city) return null;
  return city.length <= 80 ? city : undefined;
}
