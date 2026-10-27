import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SharedLineCandidate, SharedLineRole, SharedLineSession } from "@/lib/one-number/contracts";
import { isMissingSchemaError } from "@/lib/one-number/config.server";

const ROLES: readonly SharedLineRole[] = ["manager", "resident", "vendor", "applicant", "prospect"];

function asRole(value: unknown): SharedLineRole | null {
  return ROLES.find((r) => r === value) ?? null;
}

function asCandidates(value: unknown): SharedLineCandidate[] | null {
  if (!Array.isArray(value)) return null;
  const out: SharedLineCandidate[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const role = asRole(c.role);
    const workspaceId = String(c.workspaceId ?? "").trim();
    const ownerUserId = String(c.ownerUserId ?? "").trim();
    if (!role || !workspaceId || !ownerUserId) continue;
    out.push({
      workspaceId,
      ownerUserId,
      role,
      reason: c.reason as SharedLineCandidate["reason"],
      propertyId: c.propertyId == null ? null : String(c.propertyId),
      label: String(c.label ?? ""),
    });
  }
  return out.length ? out : null;
}

/** An unanswered "Is this about A or B?" goes stale; after this the next text is routed fresh. */
export const PENDING_QUESTION_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * The sticky router state for one phone. A missing table, a missing row and an
 * unreadable row all read as "no session": routing then starts from scratch,
 * which can ask a question but can never reach another team's thread.
 */
export async function loadSharedLineSession(db: SupabaseClient, phoneKey: string): Promise<SharedLineSession | null> {
  try {
    const read = (columns: string) => db.from("sms_line_sessions").select(columns).eq("phone_key", phoneKey).maybeSingle();
    let res = await read("phone_key, current_workspace_id, active_role, pending_candidates, pending_asked_at, locked_property_id, locked_at, updated_at");
    // Code that runs before the home-lock migration reads the session without the lock.
    if (res.error && isMissingSchemaError(res.error)) {
      res = await read("phone_key, current_workspace_id, active_role, pending_candidates, pending_asked_at, updated_at");
    }
    const { data, error } = res;
    if (error || !data) return null;
    const row = data as unknown as Record<string, unknown>;
    const askedAt = row.pending_asked_at ? Date.parse(String(row.pending_asked_at)) : NaN;
    const fresh = Number.isFinite(askedAt) && Date.now() - askedAt <= PENDING_QUESTION_TTL_MS;
    const thread = await db
      .from("sms_line_thread_state")
      .select("ai_paused, paused_at")
      .eq("phone_key", phoneKey)
      .eq("ai_paused", true)
      .limit(1);
    const paused = !thread.error && (thread.data ?? []).length > 0;
    return {
      phoneKey,
      currentWorkspaceId: row.current_workspace_id ? String(row.current_workspace_id) : null,
      activeRole: asRole(row.active_role),
      aiPaused: paused,
      pausedAt: paused ? String((thread.data as Array<Record<string, unknown>>)[0]?.paused_at ?? "") || null : null,
      pendingCandidates: fresh ? asCandidates(row.pending_candidates) : null,
      lockedPropertyId: row.locked_property_id ? String(row.locked_property_id) : null,
      lockedAt: row.locked_at ? String(row.locked_at) : null,
      updatedAt: String(row.updated_at ?? ""),
    };
  } catch {
    return null;
  }
}

/**
 * Remember which team and role this phone is talking to now, and clear any pending question. `lockedPropertyId` sets the
 * home lock (a string) or clears it (null); left out, the lock is untouched, so an ordinary routed text never moves it.
 */
export async function saveSharedLineRoute(
  db: SupabaseClient,
  phoneKey: string,
  route: { workspaceId: string; role: SharedLineRole; lockedPropertyId?: string | null },
): Promise<boolean> {
  const now = new Date().toISOString();
  const base = {
    phone_key: phoneKey,
    current_workspace_id: route.workspaceId,
    active_role: route.role,
    pending_candidates: null,
    pending_asked_at: null,
    last_inbound_at: now,
    updated_at: now,
  };
  const lock = route.lockedPropertyId === undefined ? {} : { locked_property_id: route.lockedPropertyId, locked_at: route.lockedPropertyId ? now : null };
  let { error } = await db.from("sms_line_sessions").upsert({ ...base, ...lock }, { onConflict: "phone_key" });
  // Before the home-lock migration the lock columns are not there: the route is still saved, the lock is not.
  if (error && isMissingSchemaError(error) && Object.keys(lock).length > 0) {
    ({ error } = await db.from("sms_line_sessions").upsert(base, { onConflict: "phone_key" }));
  }
  if (error && !isMissingSchemaError(error)) console.error("shared line session save failed", error.code ?? "unknown");
  return !error;
}

/**
 * What `sms_line_sessions` holds for a phone right now, read directly so an UNREADABLE row is told apart from a MISSING one
 * (`loadSharedLineSession` folds both into null). `null` = unreadable: the caller writes nothing.
 */
export type SessionSnapshot =
  | { exists: false; hasLockColumns: boolean }
  | {
      exists: true;
      hasLockColumns: boolean;
      workspaceId: string | null;
      role: string | null;
      lockedPropertyId: string | null;
      lockedAt: string | null;
      pendingCandidates: unknown;
      pendingAskedAt: string | null;
    };

export async function readSessionSnapshot(db: SupabaseClient, phoneKey: string): Promise<SessionSnapshot | null> {
  try {
    const read = (columns: string) => db.from("sms_line_sessions").select(columns).eq("phone_key", phoneKey).maybeSingle();
    let hasLockColumns = true;
    let res = await read("phone_key, current_workspace_id, active_role, pending_candidates, pending_asked_at, locked_property_id, locked_at");
    if (res.error && isMissingSchemaError(res.error)) {
      hasLockColumns = false;
      res = await read("phone_key, current_workspace_id, active_role, pending_candidates, pending_asked_at");
    }
    if (res.error) return null;
    if (!res.data) return { exists: false, hasLockColumns };
    const row = res.data as unknown as Record<string, unknown>;
    const text = (v: unknown) => (v == null || v === "" ? null : String(v));
    return {
      exists: true,
      hasLockColumns,
      workspaceId: text(row.current_workspace_id),
      role: text(row.active_role),
      lockedPropertyId: text(row.locked_property_id),
      lockedAt: text(row.locked_at),
      pendingCandidates: row.pending_candidates ?? null,
      pendingAskedAt: text(row.pending_asked_at),
    };
  } catch {
    return null;
  }
}

type Guarded<T> = { eq: (c: string, v: unknown) => T; is: (c: string, v: null) => T };
function guard<T extends Guarded<T>>(q: T, column: string, value: string | null): T {
  return value === null ? q.is(column, null) : q.eq(column, value);
}

/**
 * Compare-and-swap form of `saveSharedLineRoute` for a MOVE of the home lock. It applies only if the session still holds
 * the lock values `prior` was read with (or, with no row before, only if no row exists yet), so a later winner is never
 * overwritten by an earlier loser. `at` is the lock time written; the caller passes the same value to `revertSharedLineRoute`.
 * Throws and errors are `false`; zero matched rows is `false`.
 */
export async function saveSharedLineRouteIf(
  db: SupabaseClient,
  phoneKey: string,
  route: { workspaceId: string; role: SharedLineRole; lockedPropertyId: string | null },
  prior: SessionSnapshot,
  at: string,
): Promise<boolean> {
  try {
    const base = {
      current_workspace_id: route.workspaceId,
      active_role: route.role,
      pending_candidates: null,
      pending_asked_at: null,
      last_inbound_at: at,
      updated_at: at,
    };
    const lock = prior.hasLockColumns ? { locked_property_id: route.lockedPropertyId, locked_at: route.lockedPropertyId ? at : null } : {};
    if (!prior.exists) {
      const { error } = await db.from("sms_line_sessions").insert({ phone_key: phoneKey, ...base, ...lock });
      if (error) console.error("shared line session lock insert failed", error.code ?? "unknown");
      return !error;
    }
    let q = db.from("sms_line_sessions").update({ ...base, ...lock }).eq("phone_key", phoneKey);
    if (prior.hasLockColumns) {
      q = guard(q, "locked_property_id", prior.lockedPropertyId);
      q = guard(q, "locked_at", prior.lockedAt);
    }
    const { data, error } = await q.select("phone_key");
    if (error) console.error("shared line session lock update failed", error.code ?? "unknown");
    return !error && (data ?? []).length === 1;
  } catch {
    return false;
  }
}

/**
 * Undo exactly what `saveSharedLineRouteIf` wrote: only while the session still holds that request's route and lock values.
 * A session that did not exist before is removed (no lock, no route); one that did goes back to its prior route, lock and
 * pending question. A newer writer's values never match the guard, so they are left alone.
 */
export async function revertSharedLineRoute(
  db: SupabaseClient,
  phoneKey: string,
  mine: { workspaceId: string; lockedPropertyId: string | null; at: string },
  prior: SessionSnapshot,
): Promise<boolean> {
  try {
    const lockedAt = mine.lockedPropertyId ? mine.at : null;
    const guardMine = <T extends Guarded<T>>(q: T): T => {
      let g = q.eq("current_workspace_id", mine.workspaceId);
      if (prior.hasLockColumns) {
        g = guard(g, "locked_property_id", mine.lockedPropertyId);
        g = guard(g, "locked_at", lockedAt);
      }
      return g;
    };
    if (!prior.exists) {
      const { error } = await guardMine(db.from("sms_line_sessions").delete().eq("phone_key", phoneKey));
      return !error;
    }
    const restore = {
      current_workspace_id: prior.workspaceId,
      active_role: prior.role,
      pending_candidates: prior.pendingCandidates,
      pending_asked_at: prior.pendingAskedAt,
      updated_at: new Date().toISOString(),
      ...(prior.hasLockColumns ? { locked_property_id: prior.lockedPropertyId, locked_at: prior.lockedAt } : {}),
    };
    const { error } = await guardMine(db.from("sms_line_sessions").update(restore).eq("phone_key", phoneKey));
    return !error;
  } catch {
    return false;
  }
}

/** Drop the pending question without moving the route or the lock (a "no" to the switch question). */
export async function clearSharedLinePending(db: SupabaseClient, phoneKey: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { error } = await db.from("sms_line_sessions").update({ pending_candidates: null, pending_asked_at: null, updated_at: now }).eq("phone_key", phoneKey);
  return !error;
}

/** Remember the question we asked, so "1", "2" or a label on the next text resolves it. */
export async function saveSharedLinePending(
  db: SupabaseClient,
  phoneKey: string,
  candidates: SharedLineCandidate[],
): Promise<boolean> {
  const now = new Date().toISOString();
  const { error } = await db.from("sms_line_sessions").upsert(
    { phone_key: phoneKey, pending_candidates: candidates, pending_asked_at: now, last_inbound_at: now, updated_at: now },
    { onConflict: "phone_key" },
  );
  if (error && !isMissingSchemaError(error)) console.error("shared line pending save failed", error.code ?? "unknown");
  return !error;
}

export type ThreadPause = { role: SharedLineRole; reason: string | null };

/** Is the AI paused for this phone in THIS workspace only? Another team's pause never applies. */
export async function loadThreadPause(
  db: SupabaseClient,
  phoneKey: string,
  workspaceId: string,
): Promise<ThreadPause | null> {
  if (!phoneKey || !workspaceId) return null;
  try {
    const { data, error } = await db
      .from("sms_line_thread_state")
      .select("ai_paused, role, paused_reason")
      .eq("phone_key", phoneKey)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    if (row.ai_paused !== true) return null;
    return { role: asRole(row.role) ?? "prospect", reason: row.paused_reason ? String(row.paused_reason) : null };
  } catch {
    return null;
  }
}

/** HUMAN / emergency / manager takeover: pause the AI for (phone, workspace). Idempotent. */
export async function pauseThreadAi(
  db: SupabaseClient,
  input: { phoneKey: string; workspaceId: string; role: SharedLineRole; reason: "human_keyword" | "manager_takeover" | "emergency" },
): Promise<boolean> {
  const now = new Date().toISOString();
  const { error } = await db.from("sms_line_thread_state").upsert(
    {
      phone_key: input.phoneKey,
      workspace_id: input.workspaceId,
      role: input.role,
      ai_paused: true,
      paused_at: now,
      paused_reason: input.reason,
      updated_at: now,
    },
    { onConflict: "phone_key,workspace_id" },
  );
  if (error && !isMissingSchemaError(error)) console.error("shared line pause failed", error.code ?? "unknown");
  return !error;
}

/** A manager hands the thread back to the assistant. Scoped to one workspace. */
export async function resumeThreadAi(
  db: SupabaseClient,
  input: { phoneKey: string; workspaceId: string; resumedBy: string },
): Promise<boolean> {
  const now = new Date().toISOString();
  const { error } = await db
    .from("sms_line_thread_state")
    .update({ ai_paused: false, resumed_at: now, resumed_by: input.resumedBy, updated_at: now })
    .eq("phone_key", input.phoneKey)
    .eq("workspace_id", input.workspaceId);
  return !error;
}
