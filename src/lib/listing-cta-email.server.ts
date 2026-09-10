import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { listingCtaEmailAddress } from "@/lib/listing-cta-email";
import { resolveActiveManagerWorkEmail } from "@/lib/manager-assistant-email/manager-assistant-email.server";

/**
 * Resolve the `mailto:` target for ONE listing, from ITS OWN manager's live
 * work email.
 *
 * The same three rules the SMS CTA follows, for the same reasons:
 *
 * 1. Callers pass the manager who owns THAT listing — never a catalog-wide
 *    default — so a multi-manager fleet cannot cross-route a prospect.
 * 2. `profiles.email` is deliberately ignored. Emailing a manager's personal
 *    address skips the leasing assistant and the Communication inbox, and puts
 *    a private mailbox on a public page.
 * 3. `null` is not an error: the CTA components omit the Email button, so no
 *    dead `mailto:` is ever rendered.
 */
export async function resolveListingCtaEmail(
  db: SupabaseClient,
  managerUserId: string | null | undefined,
): Promise<string | null> {
  const id = managerUserId?.trim();
  if (!id) return null;
  const address = await resolveActiveManagerWorkEmail(db, id).catch(() => null);
  return listingCtaEmailAddress(address);
}

/** Batch form for the public catalog, which resolves many managers at once. */
export async function resolveListingCtaEmailsByManager(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(managerUserIds.map((id) => id?.trim()).filter((id): id is string => Boolean(id)))];
  const byManager = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      const address = await resolveListingCtaEmail(db, id);
      if (address) byManager.set(id, address);
    }),
  );
  return byManager;
}
