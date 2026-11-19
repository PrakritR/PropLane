import "server-only";

import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import {
  PLAID_ENABLED_PURPOSES,
  plaidEnabled,
  type PlaidPurpose,
} from "@/lib/plaid/client.server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertTestWorkspaceProviderEffectAllowed, TestWorkspaceProviderDisabledError } from "@/lib/test-workspaces/effects.server";

export type PlaidActor =
  | { ok: true; userId: string; db: ReturnType<typeof createSupabaseServiceRoleClient> }
  | { ok: false; status: number; error: string };

/**
 * The one gate every Plaid route passes. The user is ALWAYS the session user; a purpose decides
 * which role and permission is also required. Resident pay and income plug in here later.
 */
export async function authorizePlaidPurpose(purpose: PlaidPurpose): Promise<PlaidActor> {
  if (!plaidEnabled()) return { ok: false, status: 404, error: "Not found." };
  if (!PLAID_ENABLED_PURPOSES.includes(purpose)) return { ok: false, status: 400, error: "This bank connection is not available yet." };
  if (purpose === "bank_feed") {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return { ok: false, status: 401, error: "Unauthorized." };
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return { ok: false, status: gate.status, error: gate.error };
    return { ok: true, userId: auth.userId, db: auth.db };
  }
  if (purpose === "resident_pay") return authorizeResidentPay();
  return { ok: false, status: 400, error: "This bank connection is not available yet." };
}

/**
 * Resident bank pay. Same gate order as the typed bank path: session, resident role
 * (`authorizeResidentRole`, never `profiles.role` alone), then the test-workspace provider gate,
 * all before any Plaid or Stripe call. The owner is the session user; a body id is never ownership.
 */
async function authorizeResidentPay(): Promise<PlaidActor> {
  const auth = await createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user?.id) return { ok: false, status: 401, error: "Unauthorized." };
  const db = createSupabaseServiceRoleClient();
  const { data: profile, error } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (error || !(await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role }))) {
    return { ok: false, status: 403, error: "Resident access required." };
  }
  try {
    await assertTestWorkspaceProviderEffectAllowed({
      userId: user.id,
      kind: "payment",
      summary: "Bank link refused for a test workspace.",
      db,
    });
  } catch (error) {
    if (error instanceof TestWorkspaceProviderDisabledError) {
      return { ok: false, status: 403, error: "Payments are unavailable for test accounts." };
    }
    throw error;
  }
  return { ok: true, userId: user.id, db };
}
