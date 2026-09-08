import "server-only";

import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/**
 * Who a property's resident money belongs to.
 *
 * `ownerUserId` is null only when the property record exists but carries no
 * owner — `manager_property_records.manager_user_id` is `on delete set null`, so
 * an ownerless row is a real production state, not a bug.
 */
export type PropertyPayoutOwner =
  | { ok: true; ownerUserId: string | null }
  | { ok: false; reason: "lookup_failed" | "not_found" };

/**
 * THE ONE ANSWER to "whose bank account does this property's rent go to".
 *
 * A property has exactly one payee: its owner. Charge rows carry their own
 * `manager_user_id`, and that field used to decide the payout destination — so a
 * co-manager who created a charge on someone else's property silently made
 * themselves the payee for it, and a property ended up with as many bank
 * accounts as it had managers. Both the charge writer and the checkout resolve
 * the payee through here instead, so the two cannot disagree.
 *
 * A failed lookup is NEVER "no owner". Money must not move on a transient DB
 * blip, so callers refuse rather than falling back to the caller's own account
 * (same reasoning as `userOwnsManagerProperties` in
 * `manager-stripe-payout-access.server.ts`).
 */
export async function resolvePropertyPayoutOwner(
  db: ServiceClient,
  propertyId: string | null | undefined,
): Promise<PropertyPayoutOwner> {
  const pid = (propertyId ?? "").trim();
  if (!pid) return { ok: false, reason: "not_found" };
  const { data, error } = await db
    .from("manager_property_records")
    .select("manager_user_id")
    .eq("id", pid)
    .maybeSingle();
  if (error) return { ok: false, reason: "lookup_failed" };
  if (!data) return { ok: false, reason: "not_found" };
  const ownerUserId = String((data as { manager_user_id?: string | null }).manager_user_id ?? "").trim();
  return { ok: true, ownerUserId: ownerUserId || null };
}

/** Batch form of {@link resolvePropertyPayoutOwner} for a mirror write of many rows. */
export async function resolvePropertyPayoutOwners(
  db: ServiceClient,
  propertyIds: string[],
): Promise<Map<string, PropertyPayoutOwner>> {
  const out = new Map<string, PropertyPayoutOwner>();
  const ids = [...new Set(propertyIds.map((id) => (id ?? "").trim()).filter(Boolean))];
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, manager_user_id")
    .in("id", ids);
  if (error) {
    for (const id of ids) out.set(id, { ok: false, reason: "lookup_failed" });
    return out;
  }
  for (const row of data ?? []) {
    const id = String((row as { id?: string }).id ?? "").trim();
    if (!id) continue;
    const ownerUserId = String((row as { manager_user_id?: string | null }).manager_user_id ?? "").trim();
    out.set(id, { ok: true, ownerUserId: ownerUserId || null });
  }
  for (const id of ids) {
    if (!out.has(id)) out.set(id, { ok: false, reason: "not_found" });
  }
  return out;
}
