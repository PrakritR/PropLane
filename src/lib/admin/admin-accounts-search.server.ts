import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  accountMatchesQuery,
  loadAccountProfilesByKind,
  type AdminAccountKind,
  type AdminAccountProfile,
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
 * One query across Managers, Residents and Vendors: the match is on name, email,
 * phone or PropLane ID. Only the requested kind's page is enriched with
 * last sign-in (`auth.users`) and workspace count — the tab counts need none.
 */
export async function searchAdminAccounts(
  db: SupabaseClient,
  opts: { kind: AdminAccountKind; query: string },
): Promise<AdminAccountSearchResult> {
  const kinds: AdminAccountKind[] = ["manager", "resident", "vendor"];
  const lists = await Promise.all(kinds.map((kind) => loadAccountProfilesByKind(db, kind)));
  const matched = new Map<AdminAccountKind, AdminAccountProfile[]>();
  kinds.forEach((kind, index) => {
    matched.set(kind, lists[index]!.filter((profile) => accountMatchesQuery(profile, opts.query)));
  });

  const page = (matched.get(opts.kind) ?? []).slice(0, ADMIN_ACCOUNT_SEARCH_LIMIT);

  const workspaceCounts = new Map<string, number>();
  if (opts.kind === "manager" && page.length > 0) {
    const { data } = await db
      .from("portal_workspaces")
      .select("owner_user_id")
      .in(
        "owner_user_id",
        page.map((profile) => profile.id),
      );
    for (const row of (data ?? []) as { owner_user_id: string }[]) {
      workspaceCounts.set(row.owner_user_id, (workspaceCounts.get(row.owner_user_id) ?? 0) + 1);
    }
  }

  const lastSignIns = await mapWithConcurrency(page, LAST_SIGN_IN_CONCURRENCY, (profile) =>
    lastSignInFor(db, profile.id),
  );

  const rows: AdminAccountSearchRow[] = page.map((profile, index) => {
    const signIn = lastSignIns[index];
    const known = signIn !== undefined && signIn !== "unknown";
    return {
      id: profile.id,
      kind: opts.kind,
      email: profile.email,
      fullName: profile.fullName,
      managerId: profile.propLaneId,
      active: profile.active,
      joinedAt: profile.joinedAt,
      lastSignInAt: known ? signIn.at : null,
      lastSignInKnown: known,
      ...(opts.kind === "manager" ? { workspaceCount: workspaceCounts.get(profile.id) ?? 0 } : {}),
    };
  });

  return {
    rows,
    counts: {
      manager: matched.get("manager")?.length ?? 0,
      resident: matched.get("resident")?.length ?? 0,
      vendor: matched.get("vendor")?.length ?? 0,
    },
  };
}
