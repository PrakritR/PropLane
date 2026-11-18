import "server-only";

import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import {
  PLAID_ENABLED_PURPOSES,
  plaidEnabled,
  type PlaidPurpose,
} from "@/lib/plaid/client.server";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

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
  return { ok: false, status: 400, error: "This bank connection is not available yet." };
}
