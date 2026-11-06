import "server-only";

import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceRoleDb = ReturnType<typeof createSupabaseServiceRoleClient>;

export type InboxPortalKind = "manager" | "resident" | "vendor";

/**
 * Resolve which inbox scope a portal send/compose should use. Multi-role accounts
 * created as managers must still message their property manager from the resident
 * portal — the legacy `profiles.role` alone is wrong there.
 */
export async function resolveInboxSenderRoleForPortal(
  db: ServiceRoleDb,
  params: {
    userId: string;
    legacyRole: string | null | undefined;
    portal: InboxPortalKind;
    isAdmin: boolean;
  },
): Promise<string | null> {
  if (params.isAdmin) return "admin";

  const { data, error } = await db.from("profile_roles").select("role").eq("user_id", params.userId);
  if (error) return null;
  const roles = (data ?? []).map((row) => String(row.role ?? "").trim().toLowerCase());
  if (params.portal === "resident" && roles.includes("resident")) return "resident";
  if (params.portal === "vendor" && roles.includes("vendor")) return "vendor";
  if (params.portal === "manager" && roles.includes("manager")) return "manager";
  return null;
}
