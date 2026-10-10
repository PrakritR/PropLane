import "server-only";
import { cookies } from "next/headers";

import {
  LEAD_SOURCE_COOKIE,
  leadSourceFromCookieHeader,
  normalizeLeadSource,
  type LeadSourceChannelId,
} from "@/lib/listing-channels/lead-source";

/**
 * The validated lead source for this request, or null. Pass a `Request` to read its Cookie header,
 * a cookie store, or nothing to use the request-scoped `cookies()`. Never throws.
 */
export async function readListingSource(
  from?: Request | { get(name: string): { value: string } | undefined },
): Promise<LeadSourceChannelId | null> {
  try {
    if (from && typeof (from as Request).headers?.get === "function") {
      return leadSourceFromCookieHeader((from as Request).headers.get("cookie"));
    }
    const store = (from as { get(name: string): { value: string } | undefined } | undefined) ?? (await cookies());
    return normalizeLeadSource(store.get(LEAD_SOURCE_COOKIE)?.value);
  } catch {
    return null;
  }
}
