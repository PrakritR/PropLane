/**
 * AdminAgentContext: the PropLane operator console's agent context.
 *
 * Resolved server-side from the authenticated Supabase session and admitted
 * only for an account that holds the admin role, by the same check
 * `requireAdminRoute` uses (`isAdminUser`). It deliberately carries NO
 * `landlordId`, no manager workspace and no property scope: the admin
 * assistant answers about the PLATFORM (accounts, subscribers, earnings,
 * health, feedback), never from the operator's own manager portfolio. A
 * manager tool cannot even typecheck against this context.
 *
 * `db` is a service-role client, which bypasses RLS. Every tool in
 * `adminAgentRegistry` is read-only and calls the same server function the
 * admin UI uses; none of them takes an identity from model input.
 */
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export type AdminAgentContext = {
  kind: "admin";
  /** The authenticated operator's auth user id. */
  userId: string;
  email: string;
  isAdmin: true;
  db: ReturnType<typeof createSupabaseServiceRoleClient>;
};

/**
 * The admin agent context for the current request, or null when the caller is
 * signed out or does not hold the admin role. A null is a 401 at the route; the
 * route never distinguishes "not an admin" from "not signed in" to the client.
 */
export async function resolveAdminAgentContext(): Promise<AdminAgentContext | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  if (!(await isAdminUser(user.id))) return null;
  return {
    kind: "admin",
    userId: user.id,
    email: String(user.email ?? "").trim().toLowerCase(),
    isAdmin: true,
    db: createSupabaseServiceRoleClient(),
  };
}

/**
 * The shape the shared chat-session helpers (`ensureAgentSession`,
 * `appendAgentMessages`) expect. `agent_sessions.landlord_id` is a NOT NULL
 * scope column; for an admin it is the operator's own user id, exactly as it is
 * for a resident or a vendor. It is an inert archive key: no admin tool reads it
 * and it never names a manager workspace.
 */
export function adminSessionActor(ctx: AdminAgentContext) {
  return { userId: ctx.userId, landlordId: ctx.userId, db: ctx.db };
}
