/**
 * VendorAgentContext is resolved server-side from the authenticated Supabase
 * session. The vendor's auth user id is the only scope key (matching the
 * `vendor_user_id = auth.uid()` pattern used by the vendor RLS policies and
 * /api/vendor/* routes); every vendor tool applies it itself. This is the
 * vendor portal's single security choke point.
 */
import { getEffectiveSessionForPortal } from "@/lib/auth/effective-session";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { managerIdsOwningVendor } from "@/lib/inbox-recipient-scope";

export type VendorAgentContext = {
  kind: "vendor";
  userId: string;
  /** Normalized lowercase email (directory rows may be linked by email pre-signup). */
  email: string;
  /** Managers whose directories include this vendor. */
  managerIds: string[];
  /** audit_log/agent_sessions scope column value: the vendor's own user id. */
  landlordId: string;
  /**
   * Service-role client. It bypasses RLS, so every query built from it MUST
   * scope by `.eq("vendor_user_id", ctx.userId)` (or the owning-manager check
   * for directory rows).
   */
  db: ReturnType<typeof createSupabaseServiceRoleClient>;
};

/**
 * Returns the vendor agent context for the current request, or null when the
 * caller is unauthenticated or is not a vendor.
 */
export async function resolveVendorAgentContext(): Promise<VendorAgentContext | null> {
  const { user, profile } = await getEffectiveSessionForPortal("vendor");
  if (!user) return null;

  const db = createSupabaseServiceRoleClient();
  const { data: roleRows, error: roleError } = await db.from("profile_roles").select("role").eq("user_id", user.id);
  if (roleError) return null;
  const roleList = (roleRows ?? []).map((r) => String(r.role).toLowerCase());
  const roles = roleList;
  if (!roles.includes("vendor")) return null;

  const email = String(profile?.email ?? user.email ?? "").trim().toLowerCase();
  const managerIds = await managerIdsOwningVendor(db, { userId: user.id, email });

  return {
    kind: "vendor",
    userId: user.id,
    email,
    managerIds,
    landlordId: user.id,
    db,
  };
}
