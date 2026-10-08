import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  countMatchingAccounts,
  listAccountIdsForEveryKind,
  listSandboxAccountIds,
  profileSearchFilter,
  resolveAccountKinds,
  scanNewestProfiles,
  type AdminAccountKind,
  type AdminProfileScanRow,
} from "@/lib/admin/admin-accounts.server";

export type AdminAccountSearchRow = {
  id: string;
  kind: AdminAccountKind;
  email: string;
  fullName: string;
  /** PropLane ID. */
  managerId: string;
  active: boolean;
  joinedAt: string | null;
  /** `auth.users.last_sign_in_at`, or null when the account has never signed in. */
  lastSignInAt: string | null;
  /** False when the auth lookup failed — "unknown", never "never signed in". */
  lastSignInKnown: boolean;
  /** Managers only: workspaces this account owns. */
  workspaceCount?: number;
};

export type AdminAccountSearchResult = {
  rows: AdminAccountSearchRow[];
  /** Match counts for every kind (so the tabs stay derived from the same query). */
  counts: { manager: number; resident: number; vendor: number };
  /**
   * Always true here: `counts` are totals counted in the database. The field is
   * on the wire for the client to REQUIRE, so a response from a deploy that
   * could only report a floor leaves the tab pills off instead of showing a
   * number that is too low.
   */
  countsComplete: boolean;
};

export const ADMIN_ACCOUNT_SEARCH_LIMIT = 100;
const LAST_SIGN_IN_CONCURRENCY = 10;
const LAST_SIGN_IN_TTL_MS = 60_000;

/**
 * `auth.users` is not readable through PostgREST, so last sign-in is one admin
 * API call per account. An admin typing in the search box would otherwise
 * re-ask for the same 100 accounts on every keystroke, so a resolved answer is
 * reused for a minute. A failed or rate-limited call is NOT cached and NOT
 * reported as "never signed in": it resolves `unknown`, because a wrong fact on
 * an account record is worse than a missing one.
 */
type LastSignIn = { at: string | null } | "unknown";
const lastSignInCache = new Map<string, { at: string | null; readAt: number }>();

async function lastSignInFor(db: SupabaseClient, userId: string): Promise<LastSignIn> {
  const cached = lastSignInCache.get(userId);
  if (cached && Date.now() - cached.readAt < LAST_SIGN_IN_TTL_MS) return { at: cached.at };
  try {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error) return "unknown";
    const at = data?.user?.last_sign_in_at ?? null;
    if (lastSignInCache.size > 2_000) lastSignInCache.clear();
    lastSignInCache.set(userId, { at, readAt: Date.now() });
    return { at };
  } catch {
    return "unknown";
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The Accounts list, matched in the DATABASE.
 *
 * The match (name, email, PropLane ID, phone — `profileSearchFilter`) is one
 * `or=` over `profiles`, read newest-first a window at a time until the asked
 * kind has a full page or the rows run out (`scanNewestProfiles`), and each
 * window's kinds are resolved from `profile_roles` / `manager_purchases` for
 * those rows only. Loading every profile of all three kinds and filtering in
 * JS is what this replaced: it grew with the account table and timed the page
 * out. An empty query is the first page of accounts.
 *
 * Only the requested kind's page is enriched with last sign-in (`auth.users`)
 * and workspace count — the tab counts need neither.
 */
export async function searchAdminAccounts(
  db: SupabaseClient,
  opts: { kind: AdminAccountKind; query: string },
): Promise<AdminAccountSearchResult> {
  const match = profileSearchFilter(opts.query);

  // The tab counts are totals: counted in the database over each kind's role
  // holders (minus the sandbox accounts), never a tally of the scanned page.
  const [idsByKind, sandboxIds] = await Promise.all([listAccountIdsForEveryKind(db), listSandboxAccountIds(db)]);
  const real = (ids: string[]) => ids.filter((id) => !sandboxIds.has(id));
  const [manager, resident, vendor] = await Promise.all([
    countMatchingAccounts(db, real(idsByKind.manager), match),
    countMatchingAccounts(db, real(idsByKind.resident), match),
    countMatchingAccounts(db, real(idsByKind.vendor), match),
  ]);

  const page = await scanNewestProfiles<AdminProfileScanRow>(
    db,
    { match, limit: ADMIN_ACCOUNT_SEARCH_LIMIT },
    async (rows) => {
      const kindsById = await resolveAccountKinds(db, rows);
      return rows.filter((row) => kindsById.get(row.id)?.includes(opts.kind));
    },
  );
  const pageRows = page.slice(0, ADMIN_ACCOUNT_SEARCH_LIMIT);

  const workspaceCounts = new Map<string, number>();
  if (opts.kind === "manager" && pageRows.length > 0) {
    const { data } = await db
      .from("portal_workspaces")
      .select("owner_user_id")
      .in(
        "owner_user_id",
        pageRows.map((row) => row.id),
      );
    for (const row of (data ?? []) as { owner_user_id: string }[]) {
      workspaceCounts.set(row.owner_user_id, (workspaceCounts.get(row.owner_user_id) ?? 0) + 1);
    }
  }

  const lastSignIns = await mapWithConcurrency(pageRows, LAST_SIGN_IN_CONCURRENCY, (row) =>
    lastSignInFor(db, row.id),
  );

  const rows: AdminAccountSearchRow[] = pageRows.map((row, index) => {
    const signIn = lastSignIns[index];
    const known = signIn !== undefined && signIn !== "unknown";
    return {
      id: row.id,
      kind: opts.kind,
      email: row.email ?? "",
      fullName: row.full_name ?? "",
      managerId: row.manager_id ?? "",
      active: row.application_approved !== false,
      joinedAt: row.created_at ?? null,
      lastSignInAt: known ? signIn.at : null,
      lastSignInKnown: known,
      ...(opts.kind === "manager" ? { workspaceCount: workspaceCounts.get(row.id) ?? 0 } : {}),
    };
  });

  return { rows, counts: { manager, resident, vendor }, countsComplete: true };
}
