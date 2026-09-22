import "server-only";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkspaces } from "./server";
import { WORKSPACE_COOKIE } from "./types";

/**
 * PostgREST's `in.()` for an empty list is not portable, so a scope that
 * holds no houses matches this sentinel instead — it can never be a real
 * `property_id` (every table this touches stores it as free-form `text`).
 */
const NO_WORKSPACE_PROPERTY = "__no-workspace-property__";

export type WorkspaceRowScope = {
  /** The active workspace's houses. `null` = not narrowing (today's behavior, unchanged). */
  propertyIds: string[] | null;
  /**
   * Whether a row with NO property at all (an account-level row — a
   * portfolio bill, a manager-level document, …) is visible. Follows the
   * rule Communication already established
   * (`conversation-visibility.server.ts`'s `untaggedOwnedVisible`): only
   * when the active workspace is the viewer's OWN DEFAULT workspace.
   */
  includeUntagged: boolean;
};

/**
 * The active workspace's row scope for a manager's own money / library
 * surfaces (bills, budgets, owner distributions, expenses, documents): the
 * same `null`-means-"do not narrow" contract as
 * `activeWorkspacePropertyScope` (`@/lib/workspaces/scope.server`), resolved
 * in one workspace load that ALSO reports whether the active workspace is
 * the viewer's own default — the extra signal an account-level (no-property)
 * row needs. Read-only: never creates a workspace, and any resolution
 * failure narrows nothing (never widens what the viewer could already read).
 */
export async function resolveActiveWorkspaceRowScope(
  db: SupabaseClient,
  viewerUserId: string,
): Promise<WorkspaceRowScope> {
  let workspaces;
  try {
    workspaces = await loadWorkspaces(db, viewerUserId);
  } catch {
    return { propertyIds: null, includeUntagged: true };
  }
  if (workspaces.length === 0) return { propertyIds: null, includeUntagged: true };
  let selected: string | undefined;
  try {
    selected = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  } catch {
    // Outside a request scope (a job, a test): nothing selected, the
    // account's default workspace wins below — never a wider read.
    selected = undefined;
  }
  const active = workspaces.find((w) => w.id === selected) ?? workspaces[0];
  if (!active) return { propertyIds: null, includeUntagged: true };
  return {
    propertyIds: [...new Set(active.propertyIds.map((id) => id.trim()).filter(Boolean))],
    includeUntagged: active.owned && active.isDefault,
  };
}

/**
 * The same rule for a single row already loaded in memory (a mutation guard
 * that first fetches by id, a signed-URL mint). `propertyId` empty/undefined
 * is the account-level case.
 */
export function rowAllowedInWorkspaceScope(scope: WorkspaceRowScope, propertyId: string | null | undefined): boolean {
  if (scope.propertyIds === null) return true;
  const id = propertyId?.trim();
  if (!id) return scope.includeUntagged;
  return scope.propertyIds.includes(id);
}

/**
 * Apply the scope to a PostgREST query on `column` (default `property_id`).
 * Narrowing only — a `null` scope leaves the query untouched.
 *
 * `Q` is left unconstrained (rather than structurally matched against a
 * filter-method interface) on purpose: checking real Supabase query-builder
 * types — which grow a different generic shape after every `.eq()`/`.select()`
 * — against a structural constraint here blows up TypeScript's instantiation
 * depth. The filter calls below are cast through a minimal local shape
 * instead; every caller in this codebase passes an actual PostgREST builder,
 * whose `.in`/`.is`/`.or`/`.eq` always return another instance of itself.
 */
export function applyWorkspaceRowScope<Q>(query: Q, scope: WorkspaceRowScope, column = "property_id"): Q {
  const { propertyIds, includeUntagged } = scope;
  if (propertyIds === null) return query;
  const q = query as unknown as {
    in(col: string, v: string[]): unknown;
    is(col: string, v: null): unknown;
    or(f: string): unknown;
    eq(col: string, v: string): unknown;
  };
  if (propertyIds.length === 0) {
    return (includeUntagged ? q.is(column, null) : q.eq(column, NO_WORKSPACE_PROPERTY)) as Q;
  }
  const csv = propertyIds.join(",");
  return (includeUntagged ? q.or(`${column}.in.(${csv}),${column}.is.null`) : q.in(column, propertyIds)) as Q;
}
