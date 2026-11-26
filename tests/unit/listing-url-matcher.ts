import { listingIdToken } from "@/lib/listing-slug";

/** Matches the canonical readable URL of a listing whatever its street part is: `<origin>/rent/listings/<street>-<id token><rest>`. */
export function listingUrlRe(origin: string, id: string, rest = ""): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\?]/g, "\\$&");
  return new RegExp(`${esc(origin)}/rent/listings/[a-z0-9-]*${esc(listingIdToken(id))}${esc(rest)}`);
}
