import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Proof that a resident, signed in as themselves, bound their account to a
 * manager (`resident_workspace_bindings`). The ONLY writer is
 * `recordResidentWorkspaceBinding`, called from exactly one place: the resident
 * self-write branch of `POST /api/manager-applications`, with `residentUserId`
 * taken from the authenticated session. A manager-writable route never calls it
 * (`tests/unit/resident-workspace-binding-writers.test.ts` enforces that), so a
 * manager cannot manufacture the proof by typing someone's email into an
 * application.
 */

const TABLE = "resident_workspace_bindings";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Best effort: a failure here must never fail the applicant's own submit. */
export async function recordResidentWorkspaceBinding(
  db: SupabaseClient,
  input: { residentUserId: string; managerUserId: string | null | undefined; applicationId?: string | null },
): Promise<void> {
  const residentUserId = clean(input.residentUserId);
  const managerUserId = clean(input.managerUserId);
  if (!residentUserId || !managerUserId || residentUserId === managerUserId) return;
  try {
    const { error } = await db.from(TABLE).upsert(
      { resident_user_id: residentUserId, manager_user_id: managerUserId, application_id: clean(input.applicationId) || null },
      { onConflict: "resident_user_id,manager_user_id" },
    );
    if (error) console.error("resident workspace binding not recorded", { message: error.message });
  } catch (error) {
    console.error("resident workspace binding not recorded", { message: error instanceof Error ? error.message : String(error) });
  }
}

/** Did this resident's own session bind the account to this manager? Throws on a read error (callers fail closed). */
export async function residentBoundToManager(db: SupabaseClient, residentUserId: string, managerUserId: string): Promise<boolean> {
  const { data, error } = await db
    .from(TABLE)
    .select("resident_user_id")
    .eq("resident_user_id", clean(residentUserId))
    .eq("manager_user_id", clean(managerUserId))
    .range(0, 0);
  if (error?.code === "42P01" || error?.code === "PGRST205") return false;
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/** The manager's relationship ended; drop the proof so it cannot outlive it. */
export async function clearResidentWorkspaceBinding(db: SupabaseClient, residentUserId: string, managerUserId: string): Promise<void> {
  const { error } = await db
    .from(TABLE)
    .delete()
    .eq("resident_user_id", clean(residentUserId))
    .eq("manager_user_id", clean(managerUserId));
  if (error && error.code !== "42P01" && error.code !== "PGRST205") throw new Error(error.message);
}
