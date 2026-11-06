import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The `manager_purchases` rows that belong to ONE account.
 *
 * A row is the account's when it carries the account's `user_id` OR the account's CONFIRMED Auth email:
 * the pre-auth signup path writes the waiver row with `email` / `manager_id` and no `user_id` yet, so a
 * `user_id`-only read silently misses the row the plan resolver is reading. Anything that decides, shows
 * or ends an account's plan goes through here so the two can never disagree.
 *
 * `readFailed` separates "this account has no row" from "we could not find out" - they look identical
 * (zero rows) and mean opposite things to a quota or a refusal. A failed Auth read counts: it blanks the
 * email and silently drops the by-email half. An Auth user that does not exist does NOT: that answer is
 * conclusive ("no such account", so no email-linked row). `error` rides along so a caller that selected a
 * column added by a migration can tell "that column is not there yet" (schema parity is a manual
 * `db:push`, `AGENTS.md` § Database environments) from a real read failure, instead of refusing every
 * request.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PurchaseRowsRead<T> = {
  rows: T[];
  readFailed: boolean;
  /** The first database error behind `readFailed`, so a caller can ask `isMissingColumnError`. */
  error: { code?: string | null; message?: string | null; details?: string | null } | null;
};

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

type AuthReadError = { status?: number | null; code?: string | null; message?: string | null } | null | undefined;

/** "No such Auth user" is an ANSWER, not a failure to get one: the account owns no email-linked row. */
function isAuthUserNotFound(error: AuthReadError): boolean {
  if (!error) return false;
  if (Number(error.status) === 404) return true;
  if (String(error.code ?? "").toLowerCase() === "user_not_found") return true;
  return /user[\s_]not[\s_]found/i.test(String(error.message ?? ""));
}

/**
 * The account's own mailbox, as Auth confirmed it.
 *
 * `profiles.email` is written by server routes from caller-supplied values and can drift from the Auth
 * address, so the legacy by-email entitlement is read for the confirmed address on the Auth user itself.
 * An unconfirmed (or absent) address yields no email, which drops the by-email half; only a TRANSIENT
 * failure comes back as an error, which makes the whole read `readFailed`.
 *
 * `email_confirmed_at` is only as strong as the routes that set it, and self-serve signup still creates
 * accounts with `email_confirm: true` on a caller-supplied address. Closing those routes and replacing
 * email adoption with a verified handoff is the broad signup/onboarding fix, deliberately out of this
 * hotfix's scope; this gate is the floor, not the proof.
 */
async function readConfirmedAuthEmail(
  db: SupabaseClient,
  id: string,
): Promise<{ email: string; error: { code?: string | null; message?: string | null; details?: string | null } | null }> {
  try {
    const { data, error } = await db.auth.admin.getUserById(id);
    if (error) return { email: "", error: isAuthUserNotFound(error) ? null : error };
    const user = data?.user ?? null;
    if (!user?.email_confirmed_at) return { email: "", error: null };
    return { email: String(user.email ?? "").trim().toLowerCase(), error: null };
  } catch {
    return { email: "", error: { message: "Could not verify account email." } };
  }
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
): Promise<PurchaseRowsRead<T>> {
  const address = email.trim().toLowerCase();
  if (!address) return { rows: [], readFailed: false, error: null };
  const claimedBy = (opts.claimedBy ?? "").trim();
  // `claimedBy` is interpolated into a PostgREST `or` filter, so only a real auth uuid is accepted.
  if (claimedBy && !UUID_PATTERN.test(claimedBy)) return { rows: [], readFailed: true, error: null };

  const base = db.from("manager_purchases").select(withEmailColumn(select)).ilike("email", escapeLikePattern(address));
  const { data, error } = await (claimedBy ? base.or(`user_id.is.null,user_id.eq.${claimedBy}`) : base);
  const rows = ((data ?? []) as unknown as Array<T & { email?: unknown }>).filter((row) => sameEmail(row.email, address));
  return { rows, readFailed: Boolean(error), error: error ?? null };
}

export async function loadAccountPurchaseRows<T extends { id: string }>(
  db: SupabaseClient,
  userId: string,
  /** PostgREST select list; it MUST include `id`, which is how the two halves are merged. */
  select: string,
): Promise<PurchaseRowsRead<T>> {
  const id = userId.trim();
  if (!id) return { rows: [], readFailed: false, error: null };
  // Only a real auth uuid reaches the by-email half, whose claim filter is interpolated into a
  // PostgREST `or`. The `user_id` read below is parameterized, so it still answers for any id -
  // an id that is not an auth uuid simply owns no Auth mailbox and so no email-linked row.
  const isAuthId = UUID_PATTERN.test(id);

  // Both reads depend only on `id`, so neither waits on the other: this backs every portal page's plan
  // resolution, and a serialized Auth round trip would be paid on each one.
  const [byUserId, account] = await Promise.all([
    db.from("manager_purchases").select(select).eq("user_id", id),
    isAuthId ? readConfirmedAuthEmail(db, id) : Promise.resolve({ email: "", error: null }),
  ]);

  // Exact, case-insensitive match on the CONFIRMED address; a by-email row already claimed by a
  // DIFFERENT account is never this account's (`loadPurchaseRowsByEmail`).
  const byEmail = account.email
    ? await loadPurchaseRowsByEmail<T>(db, account.email, select, { claimedBy: id })
    : { rows: [] as T[], readFailed: false, error: null };

  const merged = new Map<string, T>();
  for (const row of [...(byUserId.data ?? []), ...byEmail.rows]) {
    merged.set(String((row as { id?: unknown }).id), row as T);
  }
  return {
    rows: [...merged.values()],
    readFailed: Boolean(account.error) || Boolean(byUserId.error) || byEmail.readFailed,
    error: account.error ?? byUserId.error ?? byEmail.error ?? null,
  };
}
