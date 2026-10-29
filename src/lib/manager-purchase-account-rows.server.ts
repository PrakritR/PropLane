import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The `manager_purchases` rows that belong to ONE account.
 *
 * A row is the account's when it carries the account's `user_id` OR the account's email: the pre-auth
 * signup path writes the waiver row with `email` / `manager_id` and no `user_id` yet, so a `user_id`-only
 * read silently misses the row the plan resolver is reading. Anything that decides, shows or ends an
 * account's plan goes through here so the two can never disagree.
 *
 * `readFailed` separates "this account has no row" from "we could not find out" - they look identical
 * (zero rows) and mean opposite things to a quota or a refusal. A failed `profiles` read counts: it blanks
 * the email and silently drops the by-email half.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function sameEmail(stored: unknown, address: string): boolean {
  return typeof stored === "string" && stored.trim().toLowerCase() === address;
}

/** The select list the by-email read needs: `email` comes back so the match can be re-checked here. */
function withEmailColumn(select: string): string {
  return /(^|,)\s*(email|\*)\s*(,|$)/.test(select) ? select : `${select}, email`;
}

/**
 * Rows whose `email` is EXACTLY this address (case-insensitive).
 *
 * `ilike` is a LIKE pattern: `%` and `_` in an address are escaped, and PostgREST reads `*` as `%`
 * whatever the escaping, so the address is compared again in JS - a wildcard can never widen the
 * match. `claimedBy` additionally keeps a row another account already claimed out of the answer.
 */
export async function loadPurchaseRowsByEmail<T extends { id: string }>(
  db: SupabaseClient,
  email: string,
  /** PostgREST select list; `email` is added when absent. */
  select: string,
  opts: { claimedBy?: string | null } = {},
): Promise<{ rows: T[]; readFailed: boolean }> {
  const address = email.trim().toLowerCase();
  if (!address) return { rows: [], readFailed: false };
  const claimedBy = (opts.claimedBy ?? "").trim();
  // `claimedBy` is interpolated into a PostgREST `or` filter, so only a real auth uuid is accepted.
  if (claimedBy && !UUID_PATTERN.test(claimedBy)) return { rows: [], readFailed: true };

  const base = db.from("manager_purchases").select(withEmailColumn(select)).ilike("email", escapeLikePattern(address));
  const { data, error } = await (claimedBy ? base.or(`user_id.is.null,user_id.eq.${claimedBy}`) : base);
  const rows = ((data ?? []) as unknown as Array<T & { email?: unknown }>).filter((row) => sameEmail(row.email, address));
  return { rows, readFailed: Boolean(error) };
}

export async function loadAccountPurchaseRows<T extends { id: string }>(
  db: SupabaseClient,
  userId: string,
  /** PostgREST select list; it MUST include `id`, which is how the two halves are merged. */
  select: string,
): Promise<{ rows: T[]; readFailed: boolean }> {
  const id = userId.trim();
  if (!id) return { rows: [], readFailed: false };
  // Only a real auth uuid reaches the by-email half, whose claim filter is interpolated into a
  // PostgREST `or`. The `user_id` read below is parameterized, so it still answers for any id -
  // an id that is not an auth uuid simply owns no `profiles` row and so no email-linked row.
  const isAuthId = UUID_PATTERN.test(id);

  const { data: profile, error: profileError } = isAuthId
    ? await db.from("profiles").select("email").eq("id", id).maybeSingle()
    : { data: null, error: null };
  const email = String((profile as { email?: unknown } | null)?.email ?? "").trim().toLowerCase();

  const [byUserId, byEmail] = await Promise.all([
    db.from("manager_purchases").select(select).eq("user_id", id),
    // Exact, case-insensitive match; a by-email row already claimed by a DIFFERENT account is never
    // this account's (`loadPurchaseRowsByEmail`).
    email
      ? loadPurchaseRowsByEmail<T>(db, email, select, { claimedBy: id })
      : Promise.resolve({ rows: [] as T[], readFailed: false }),
  ]);

  const merged = new Map<string, T>();
  for (const row of [...(byUserId.data ?? []), ...byEmail.rows]) {
    merged.set(String((row as { id?: unknown }).id), row as T);
  }
  return {
    rows: [...merged.values()],
    readFailed: Boolean(profileError) || Boolean(byUserId.error) || byEmail.readFailed,
  };
}
