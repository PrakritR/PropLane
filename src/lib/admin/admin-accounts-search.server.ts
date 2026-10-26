import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  countMatchingAccounts,
  listAccountIdsForEveryKind,
  listSandboxAccountIds,
  PROFILE_SCAN_SELECT,
  profileSearchFilter,
  resolveAccountKinds,
  scanNewestProfiles,
  type AdminAccountKind,
  type AdminProfileScanRow,
} from "@/lib/admin/admin-accounts.server";
import { loadSubscriberPopulation } from "@/lib/admin/admin-subscribers.server";
import { SUBSCRIBER_TABS, type SubscriberBucket } from "@/lib/admin/admin-subscribers-shared";
import { loadProfilesByIdChunks } from "@/lib/auth/admin-portal-manager-ids.server";
import { isPortalSandboxEmail } from "@/lib/portal-sandbox-accounts";
import { createTtlCache, serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";

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
  /**
   * The same totals over ACTIVE accounts only. The list opens on its Active
   * status, so the tab pills read this: a pill and the rows beneath it describe
   * the same accounts (a disabled account is counted under Disabled instead).
   */
  activeCounts: { manager: number; resident: number; vendor: number };
};

/** The Plan filter on Accounts > Managers: the same four buckets the Dashboard cards count (Paid, Trial, Promo, Free). */
export type AdminAccountPlanFilter = SubscriberBucket;

export function accountPlanFromParam(raw: string | null | undefined): AdminAccountPlanFilter | null {
  const value = String(raw ?? "").trim().toLowerCase();
  return SUBSCRIBER_TABS.some((tab) => tab.id === value) ? (value as AdminAccountPlanFilter) : null;
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * One plan bucket's managers, already classified: the profile rows, the promo code each account used, and
 * which of them actually hold the manager role. The SEARCH TERM is not part of it, because the whole bucket
 * is what a search filters down — see `managersInPlan`.
 */
type PlanBucket = {
  profiles: AdminProfileScanRow[];
  /** Lowercase promo code per account id, for the promo link's "View accounts". */
  codes: Map<string, string>;
  kinds: Map<string, AdminAccountKind[]>;
};

/**
 * The bucket is the same answer for every operator and every keystroke, and building it costs a paged read of
 * the whole real-manager population plus their profiles and roles. An admin typing in the search box would
 * otherwise pay that scan per request, so one bucket is held for this long — the same stance `lastSignInFor`
 * below takes, and never longer than the list is plausibly being typed into.
 */
const PLAN_BUCKET_TTL_MS = 30_000;
const planBucketCache = createTtlCache<PlanBucket>(PLAN_BUCKET_TTL_MS, Date.now, { maxEntries: SUBSCRIBER_TABS.length });

async function loadPlanBucket(db: SupabaseClient, plan: AdminAccountPlanFilter): Promise<PlanBucket> {
  const population = await loadSubscriberPopulation(db);
  const bucket = population.rows.filter((row) => row.bucket === plan);
  const codes = new Map(bucket.map((row) => [row.id, (row.promoCode ?? "").toLowerCase()]));
  const profiles = await loadProfilesByIdChunks<AdminProfileScanRow>(
    db,
    bucket.map((row) => row.id),
    PROFILE_SCAN_SELECT,
  );
  // The subscriber population admits anyone carrying a PropLane ID, so a resident or vendor would read as Free;
  // the Managers tab lists managers by role, and so does this.
  const kinds = await resolveAccountKinds(db, profiles);
  return { profiles, codes, kinds };
}

/**
 * Managers in one plan bucket, newest first. The bucket comes from the SAME classifier enforcement and the
 * Dashboard use (`loadSubscriberPopulation`); the search term matches name, email, PropLane ID, phone and the
 * promo code the account used, so a promo code's "View accounts" link lands on exactly those accounts.
 */
async function managersInPlan(
  db: SupabaseClient,
  plan: AdminAccountPlanFilter,
  query: string,
): Promise<AdminProfileScanRow[]> {
  const load = () => loadPlanBucket(db, plan);
  const { profiles, codes, kinds } = serverSnapshotCacheEnabled() ? await planBucketCache.get(plan, load) : await load();
  const needle = query.trim().toLowerCase();
  const needleDigits = digitsOf(needle);
  const matches = (row: AdminProfileScanRow) => {
    if (!kinds.get(row.id)?.includes("manager")) return false;
    if (!needle) return true;
    const text = `${row.email ?? ""} ${row.full_name ?? ""} ${row.manager_id ?? ""} ${codes.get(row.id) ?? ""}`;
    if (text.toLowerCase().includes(needle)) return true;
    return needleDigits.length >= 3 && digitsOf(row.phone ?? "").includes(needleDigits);
  };
  return profiles
    .filter((row) => !isPortalSandboxEmail(row.email) && matches(row))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || a.id.localeCompare(b.id));
}

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
  opts: { kind: AdminAccountKind; query: string; plan?: AdminAccountPlanFilter | null },
): Promise<AdminAccountSearchResult> {
  const match = profileSearchFilter(opts.query);
  // The Plan filter narrows Managers only. Its bucket decides who is listed and counted as a manager; the other two
  // tabs keep their ordinary counts so the strip still describes the same search.
  const planned = opts.plan && opts.kind === "manager" ? await managersInPlan(db, opts.plan, opts.query) : null;

  // The tab counts are totals: counted in the database over each kind's role
  // holders (minus the sandbox accounts), never a tally of the scanned page.
  const [idsByKind, sandboxIds] = await Promise.all([listAccountIdsForEveryKind(db), listSandboxAccountIds(db)]);
  const real = (ids: string[]) => ids.filter((id) => !sandboxIds.has(id));
  const kinds = ["manager", "resident", "vendor"] as const;
  const [allCounts, activeOnly] = await Promise.all([
    Promise.all(kinds.map((kind) => countMatchingAccounts(db, real(idsByKind[kind]), match))),
    Promise.all(kinds.map((kind) => countMatchingAccounts(db, real(idsByKind[kind]), match, { activeOnly: true }))),
  ]);
  const [allManager, resident, vendor] = allCounts as [number, number, number];
  const manager = planned ? planned.length : allManager;
  const activeCounts = {
    manager: planned ? planned.filter((row) => row.application_approved !== false).length : activeOnly[0]!,
    resident: activeOnly[1]!,
    vendor: activeOnly[2]!,
  };

  const page =
    planned ??
    (await scanNewestProfiles<AdminProfileScanRow>(db, { match, limit: ADMIN_ACCOUNT_SEARCH_LIMIT }, async (rows) => {
      const kindsById = await resolveAccountKinds(db, rows);
      return rows.filter((row) => kindsById.get(row.id)?.includes(opts.kind));
    }));
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

  return { rows, counts: { manager, resident, vendor }, countsComplete: true, activeCounts };
}
